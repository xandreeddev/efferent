import { AiError, LanguageModel } from "@effect/ai"
import { FetchHttpClient, HttpClient } from "@effect/platform"
import {
  agentSpanAttributes,
  AuthStore,
  classifyProviderError,
  costAttribute,
  extractUsage,
  genAiContentAttributes,
  LlmInfo,
  llmSpanName,
  ModelRegistry,
  modelForRole,
  recordError,
  recordLlmCall,
  responseText,
  roleIsConfigured,
  parseRetryAfterMs,
  RunContextRef,
  selectionFromString,
  SettingsStore,
  usageAttributes,
  type ModelSelection,
} from "@xandreed/sdk-core"
import { Clock, Duration, Effect, FiberRef, Layer, Ref, Stream } from "effect"
import { ModelRegistryLive } from "./modelRegistry.js"
import { retryableLlm, withLlmTimeout } from "./retry.js"
import {
  makeProviderLanguageModel,
  prependClaudeCode,
  withAnthropicCacheBreakpoints,
} from "./providers.js"

/** The typed error's `_tag` (a bounded label) for the `llm` error metric. */
const llmErrorTag = (e: unknown): string => {
  const t = (e as { readonly _tag?: unknown } | null)?._tag
  return typeof t === "string" ? t : "unknown"
}

/**
 * ===== Quota park ("sleep till it's ready") =====
 * When a QUOTA wall has a knowable reset time and there is no fallback model,
 * failing the turn is strictly worse than what Claude Code does: announce the
 * reset time, sleep until it, and resume. The park is interactive-only, ROOT-
 * only (a parked fleet would burn its stall budget for nothing — the root
 * respawns workers after it wakes), always visible (a countdown notice every
 * slice), and interruptible (Esc cancels the sleep like any fiber).
 */
export const QUOTA_PARK_CEILING_MS = 24 * 60 * 60_000
const QUOTA_PARK_SLICE_MS = 10 * 60_000
/** Wake a touch late, never a touch early. */
const QUOTA_PARK_MARGIN_MS = 5_000

/**
 * The provider's own reset delay for a quota error, when it names one:
 * `Retry-After` (opencode's daily quota = seconds until the midnight-UTC
 * reset) or Anthropic's `anthropic-ratelimit-unified-reset` (epoch seconds —
 * the subscription session-cap header). Undefined ⇒ no knowable reset (e.g.
 * "insufficient balance" — money, not time; a human must act).
 */
export const quotaResetDelayMs = (e: unknown, nowMs: number): number | undefined => {
  if (!AiError.isAiError(e) || e._tag !== "HttpResponseError") return undefined
  const h = e.response.headers
  const ra = parseRetryAfterMs(h["retry-after"] ?? h["Retry-After"], nowMs)
  if (ra !== undefined && ra > 0) return ra
  const unified = h["anthropic-ratelimit-unified-reset"]
  if (unified !== undefined) {
    const at = Number(unified)
    if (Number.isFinite(at)) {
      const delta = Math.round(at * 1000 - nowMs)
      return delta > 0 ? delta : undefined
    }
  }
  return undefined
}

/** The park decision, pure — pinned by tests. */
export const planQuotaPark = (input: {
  readonly cls: string | undefined
  readonly policy: "interactive" | "headless" | undefined
  readonly depth: number
  readonly resetDelayMs: number | undefined
  readonly parkedMs: number
}): { readonly park: boolean; readonly delayMs: number } =>
  input.cls === "quota" &&
  input.policy === "interactive" &&
  input.depth === 0 &&
  input.resetDelayMs !== undefined &&
  input.resetDelayMs > 0 &&
  input.parkedMs + input.resetDelayMs <= QUOTA_PARK_CEILING_MS
    ? { park: true, delayMs: input.resetDelayMs + QUOTA_PARK_MARGIN_MS }
    : { park: false, delayMs: 0 }

const clockTime = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
}

/**
 * True when a "successful" response carries NOTHING — no text, no tool call,
 * no reasoning. The opencode gateway under load answers HTTP 200 with an empty
 * body and `finishReason: "unknown"` (`turn N: unknown · 0 tok` in the July
 * forensics); the loop read that as a completed turn, so agents "finished"
 * mid-thought and a mid-sentence line became the recorded deliverable.
 */
export const isEmptyResponseContent = (
  content: ReadonlyArray<{ readonly type?: string; readonly text?: string }>,
): boolean =>
  !content.some(
    (p) =>
      (p.type === "text" && (p.text ?? "").trim().length > 0) ||
      p.type === "tool-call" ||
      (p.type === "reasoning" && (p.text ?? "").trim().length > 0),
  )

/**
 * Fail an empty response as a *transient* provider error. Placed INSIDE the
 * retry wrap, so an empty body is retried like any other blip instead of
 * fake-completing the turn. E is preserved via the router's established cast
 * class (the failure is a real AiError at runtime).
 */
const rejectEmptyResponse =
  (label: string) =>
  <A extends { readonly content: ReadonlyArray<{ readonly type?: string; readonly text?: string }> }, E, R>(
    eff: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(eff, (res) =>
      isEmptyResponseContent(res.content)
        ? Effect.fail(
            new AiError.UnknownError({
              module: "llm",
              method: "generateText",
              description: `empty model response from ${label} (no text, no tool calls)`,
            }) as never,
          )
        : Effect.succeed(res),
    )

/**
 * Flatten an `@effect/ai` Prompt (array of messages, or `{ content: [...] }`)
 * to readable `### role\n<text>` blocks for the opt-in `gen_ai.prompt` span
 * attribute. Defensive over the runtime shape; non-text parts show as `[type]`.
 */
const promptToText = (prompt: unknown): string => {
  const msgs = Array.isArray(prompt) ? prompt : (prompt as { content?: unknown } | null)?.content
  if (!Array.isArray(msgs)) return ""
  const blocks: Array<string> = []
  for (const m of msgs as Array<{ role?: unknown; content?: unknown }>) {
    const role = typeof m.role === "string" ? m.role : "?"
    const c = m.content
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? (c as Array<{ text?: unknown; type?: unknown }>)
              .map((p) =>
                typeof p.text === "string" ? p.text : typeof p.type === "string" ? `[${p.type}]` : "",
              )
              .join("")
          : ""
    blocks.push(`### ${role}\n${text}`)
  }
  return blocks.join("\n\n")
}

/**
 * The single `LanguageModel` the agent loop talks to. It is provider-agnostic:
 * on every call it reads `ModelRegistry.current`, resolves a usable credential
 * from `AuthStore`, and delegates to the selected concrete provider adapter.
 *
 * Concrete provider quirks live in sibling adapter modules. The router only
 * handles runtime selection and shared lifecycle/scoping.
 */
export const RouterLanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const settingsStore = yield* SettingsStore
    const http = yield* HttpClient.HttpClient

    // The selection for THIS call is decided ENTIRELY by the fiber's role —
    // never by anything the running model emitted (there is no per-agent model
    // channel). The top-level run is `general`; a spawned sub-agent is `general`
    // or `code` (its spawned role). The run pins all roles at start
    // (`RunContext.pinnedModels`), so the router resolves this fiber's role to
    // its pinned selection and a mid-run `/model` / `:set` can't move a running
    // fleet — which also keeps each provider's prompt-cache prefix warm. With no
    // pin (a helper outside a run), fall back to settings → live. Pure parse — no
    // settings write — so the status bar (`LlmInfoLive`) keeps showing the model.
    const currentSelection = Effect.gen(function* () {
      const rc = yield* FiberRef.get(RunContextRef)
      const role = rc.modelRole ?? "general"
      const pinned = rc.pinnedModels?.[role]
      if (pinned !== undefined) return selectionFromString(pinned)
      if (role === "general") return yield* registry.current
      const settings = yield* settingsStore.get()
      return roleIsConfigured(settings, role)
        ? selectionFromString(modelForRole(settings, role))
        : yield* registry.current
    })

    const resolveAndBuild = (sel: ModelSelection) =>
      Effect.gen(function* () {
        const cred = yield* authStore.get(sel.provider)
        // A resolveKey FAILURE is a failed OAuth refresh — surface it (the
        // error says "run :login <provider> again"); masking it as "no
        // credential" reads as the model silently vanishing. The error is a
        // real AiError at runtime (rendered by every mode's failure path);
        // statically it's erased — `ExtractError<Options>` is a generic this
        // signature can't widen (same cast class as `prependClaudeCode`).
        const key = yield* authStore
          .resolveKey(sel.provider)
          .pipe(
            Effect.mapError(
              (e) =>
                new AiError.UnknownError({
                  module: "Router",
                  method: "resolveKey",
                  description: e.message,
                }) as never,
            ),
          )
        const settings = yield* settingsStore.get()
        return yield* makeProviderLanguageModel(sel, key, cred, settings)
      })

    // Per-call prompt shaping: the Claude-Code system block (OAuth), then
    // Anthropic cache breakpoints — Anthropic caches nothing without them.
    const shapeOptions = <O>(sel: ModelSelection, shouldPrepend: boolean, options: O): O => {
      let shaped: unknown = options
      if (shouldPrepend) shaped = prependClaudeCode(shaped)
      if (sel.provider === "anthropic") shaped = withAnthropicCacheBreakpoints(shaped)
      return shaped as O
    }

    // Annotate the active `llm.generate` span + record metrics for one main-tier
    // response. Pure observation — the response passes through untouched. When
    // `telemetryCaptureContent` is on, the prompt + completion text are attached
    // too (clipped) so the call's I/O reads right in the trace.
    /**
     * Build a human-readable span name for an LLM call: `llm.generate` plus the
     * prompt label (name:variant@version) and provider/model. Falls back to the
     * role when no prompt identity is in context (e.g. stray utility calls).
     */
    const spanName = (sel: ModelSelection, role: string) =>
      Effect.gen(function* () {
        const rc = yield* FiberRef.get(RunContextRef)
        return llmSpanName(rc.prompt, role, sel.provider, sel.modelId)
      })

    /**
     * Wrap an LLM Effect in a span whose name includes the prompt identity and
     * selected model. The name is computed from `RunContextRef` at wrap time so
     * `observe` annotates the same span.
     */
    const withLlmSpan =
      <A, E, R>(sel: ModelSelection, role: string) =>
      (eff: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
        Effect.gen(function* () {
          const name = yield* spanName(sel, role)
          return yield* eff.pipe(Effect.withSpan(name))
        })

    const observe = (
      sel: ModelSelection,
      options: unknown,
      res: { usage?: unknown; content?: ReadonlyArray<unknown> },
    ) =>
      Effect.gen(function* () {
        const usage = extractUsage(res.usage, res.content ?? [])
        const settings = yield* settingsStore.get()
        // Capturing prompt/completion goes hand in hand with telemetry being on
        // — no separate knob. (Serialize only when on; when off the span is a
        // no-op anyway.)
        const content =
          settings.telemetry === true
            ? genAiContentAttributes(
                promptToText((options as { prompt?: unknown }).prompt),
                responseText(res.content ?? []),
              )
            : {}
        const rc = yield* FiberRef.get(RunContextRef)
        yield* Effect.annotateCurrentSpan({
          ...agentSpanAttributes("llm", rc.rootConversationId),
          "gen_ai.request.model": sel.modelId,
          "gen_ai.system": sel.provider,
          "gen_ai.role": rc.modelRole ?? "general",
          "gen_ai.operation.name": "generate",
          ...(rc.prompt !== undefined
            ? {
                "agent.prompt.name": rc.prompt.name,
                "agent.prompt.version": rc.prompt.version,
                ...(rc.prompt.variant !== undefined
                  ? { "agent.prompt.variant": rc.prompt.variant }
                  : {}),
              }
            : {}),
          ...usageAttributes(usage),
          ...costAttribute(sel.provider, sel.modelId, usage),
          ...content,
        })
        yield* recordLlmCall("main", sel.provider, sel.modelId, usage)
        // Emit the same prompt/completion as trace+span-correlated logs so
        // Grafana's "Logs for this span" on the `llm.generate` span shows the
        // call's input & output. Span attributes are easy to miss; the logs
        // pane is where people look. Reuses the already-clipped attribute
        // values, gated on telemetry like them, and runs inside the span scope
        // so the lines carry this span's id and fall within its time window
        // (the per-turn heartbeat is logged later, outside this span, which is
        // why it never showed here).
        const output = content["gen_ai.completion"]
        if (output !== undefined) yield* Effect.logInfo(`llm output ▸ ${output}`)
        const input = content["gen_ai.prompt"]
        if (input !== undefined) yield* Effect.logInfo(`llm input ▸ ${input}`)
      })

    // A failed `llm.generate` (bad/expired key, provider 4xx/5xx, rate limit)
    // marks the span errored + records the bounded `_tag`, then re-raises — RED
    // panels read `agent_errors_total{kind="llm"}`. Observe-only.
    const observeError = (e: unknown) =>
      Effect.annotateCurrentSpan({ error: true }).pipe(
        Effect.zipRight(recordError("llm", llmErrorTag(e))),
      )

    // The failover selection for a PERSISTENT provider defect: the code role
    // falls back to the run's pinned GENERAL model; the general role to the
    // human-configured `Settings.fallbackModel`. Never a model the agent chose,
    // never the same selection that just failed, undefined ⇒ no failover.
    const fallbackSelection = (sel: ModelSelection) =>
      Effect.gen(function* () {
        const rc = yield* FiberRef.get(RunContextRef)
        const role = rc.modelRole ?? "general"
        const raw =
          role === "code"
            ? (rc.pinnedModels?.general ?? (yield* settingsStore.get()).fallbackModel)
            : (yield* settingsStore.get()).fallbackModel
        if (raw === undefined) return undefined
        const fb = selectionFromString(raw)
        return fb.provider === sel.provider && fb.modelId === sel.modelId ? undefined : fb
      })

    /**
     * Self-healing failover: when a call dies with a defect that retrying in
     * place can't fix — `quota` (out of credits/daily budget for hours),
     * `config` (this model rejects the request shape), or a `transient` that
     * EXHAUSTED the retry ladder (the provider is genuinely down; by the time a
     * transient escapes `retryableLlm` it has been retried for the run's whole
     * patience budget) — retry the call ONCE on the fallback selection, loudly:
     * the notice rides the retry sink (rail/node log + health), and a per-run
     * annotation is folded into the terminal outcome's notes. `auth` never
     * fails over (credentials are the human's); `model` (malformed output) is
     * the loop's recovery to own.
     */
    /**
     * The quota park: no fallback to switch to, but the wall names its own
     * reset time — so wait it out (in visible slices) and re-attempt. Loops
     * while the provider keeps answering quota-with-reset, up to the 24h
     * ceiling; any other failure (or an unknowable reset) surfaces. The sleep
     * is ordinary fiber sleep — Esc interrupts it like any running turn.
     */
    const parkThroughQuota = <A, E, R>(
      sel: ModelSelection,
      attempt: (s: ModelSelection) => Effect.Effect<A, E, R>,
      firstError: E,
    ): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const rc = yield* FiberRef.get(RunContextRef)
        let err = firstError
        let parkedMs = 0
        while (true) {
          const now = yield* Clock.currentTimeMillis
          const plan = planQuotaPark({
            cls: classifyProviderError(err),
            policy: rc.interactionPolicy,
            depth: rc.depth,
            resetDelayMs: quotaResetDelayMs(err, now),
            parkedMs,
          })
          if (!plan.park) return yield* Effect.fail(err)
          const resetsAt = clockTime(now + plan.delayMs)
          yield* Effect.logWarning(
            `LLM quota wall on ${sel.provider}:${sel.modelId} — parking until ≈${resetsAt} (${Math.round(plan.delayMs / 60_000)}m); Esc cancels, :model switches`,
          )
          yield* Effect.annotateCurrentSpan({
            "llm.quota_park": true,
            "llm.quota_park.delay_ms": plan.delayMs,
          })
          // Sleep in slices, announcing each — the countdown stays alive in
          // the rail without flooding it (one line per 10 min).
          let remaining = plan.delayMs
          while (remaining > 0) {
            const slice = Math.min(remaining, QUOTA_PARK_SLICE_MS)
            if (rc.onLlmRetry !== undefined) {
              yield* rc.onLlmRetry({
                reason: `quota on ${sel.provider}:${sel.modelId} — resets ≈${resetsAt}`,
                attempt: 1,
                maxAttempts: 1,
                delayMs: slice,
                elapsedMs: parkedMs,
                budgetMs: QUOTA_PARK_CEILING_MS,
              })
            }
            yield* Effect.sleep(Duration.millis(slice))
            parkedMs += slice
            remaining -= slice
          }
          const res = yield* Effect.either(attempt(sel))
          if (res._tag === "Right") return res.right
          err = res.left
        }
      })

    const withFailover = <A, E, R>(
      sel: ModelSelection,
      attempt: (s: ModelSelection) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      attempt(sel).pipe(
        Effect.catchAll((e: E) => {
          const cls = classifyProviderError(e)
          if (cls !== "quota" && cls !== "config" && cls !== "transient") return Effect.fail(e)
          return fallbackSelection(sel).pipe(
            Effect.flatMap((fb) => {
              // No fallback configured ⇒ the quota park is the last resort
              // (non-quota classes, unknowable resets, headless runs, and
              // sub-agents fall straight through to the failure).
              if (fb === undefined) return parkThroughQuota(sel, attempt, e)
              const from = `${sel.provider}:${sel.modelId}`
              const to = `${fb.provider}:${fb.modelId}`
              const announce = Effect.gen(function* () {
                const rc = yield* FiberRef.get(RunContextRef)
                if (rc.onLlmRetry !== undefined) {
                  yield* rc.onLlmRetry({
                    reason: `${cls} on ${from} — failing over to ${to}`,
                    attempt: 1,
                    maxAttempts: 1,
                    delayMs: 0,
                  })
                }
                if (rc.failoverNotes !== undefined) {
                  yield* Ref.update(rc.failoverNotes, (ns) => [
                    ...ns,
                    `[failover: ${from} → ${to} after ${cls}]`,
                  ])
                }
                yield* Effect.logWarning(`LLM failover: ${from} → ${to} (${cls})`)
                yield* Effect.annotateCurrentSpan({
                  "llm.failover": true,
                  "llm.failover.from": from,
                  "llm.failover.to": to,
                  "llm.failover.class": cls,
                })
              })
              return announce.pipe(
                Effect.zipRight(attempt(fb)),
                // Both selections down: if the SECOND failure is a quota wall
                // with a knowable reset, park and re-attempt the original
                // selection after it — the last resort behind the failover.
                Effect.catchAll((e2: E) => parkThroughQuota(sel, attempt, e2)),
              )
            }),
          )
        }),
      )

    const service: LanguageModel.Service = {
      generateText: (options) =>
        currentSelection.pipe(
          Effect.flatMap((sel) =>
            withFailover(sel, (s) =>
              resolveAndBuild(s).pipe(
                Effect.flatMap(({ svc, prependClaudeCode: shouldPrepend }) =>
                  svc
                    .generateText(shapeOptions(s, shouldPrepend, options))
                    .pipe(
                      // Bound each attempt (official providers ship no timeout)
                      // and reject an empty body, THEN retry — both are
                      // classified transient and ride the same ladder.
                      withLlmTimeout(`${s.provider}:${s.modelId}`),
                      rejectEmptyResponse(`${s.provider}:${s.modelId}`),
                      retryableLlm,
                      Effect.tap((res) => observe(s, options, res)),
                      Effect.tapError(observeError),
                    )
                    .pipe(withLlmSpan(s, "main")),
                ),
              ),
            ),
          ),
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, http),
        ),

      generateObject: (options) =>
        currentSelection.pipe(
          Effect.flatMap((sel) =>
            withFailover(sel, (s) =>
              resolveAndBuild(s).pipe(
                Effect.flatMap(({ svc, prependClaudeCode: shouldPrepend }) =>
                  svc
                    .generateObject(shapeOptions(s, shouldPrepend, options))
                    .pipe(
                      withLlmTimeout(`${s.provider}:${s.modelId}`),
                      retryableLlm,
                      Effect.tap((res) => observe(s, options, res)),
                      Effect.tapError(observeError),
                    )
                    .pipe(withLlmSpan(s, "main")),
                ),
              ),
            ),
          ),
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, http),
        ),

      streamText: (options) =>
        Stream.unwrapScoped(
          currentSelection.pipe(
            Effect.flatMap((sel) =>
              resolveAndBuild(sel).pipe(
                Effect.map(({ svc, prependClaudeCode: shouldPrepend }) =>
                  svc.streamText(shapeOptions(sel, shouldPrepend, options)),
                ),
              ),
            ),
            Effect.provideService(HttpClient.HttpClient, http),
          ),
        ),
    }
    return service
  }),
)

/** Status-bar metadata follows the live selection (model id + window). */
export const LlmInfoLive = Layer.effect(
  LlmInfo,
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    return {
      metadata: registry.current.pipe(
        Effect.map((sel) => ({
          modelId: sel.modelId,
          contextWindow: sel.contextWindow,
        })),
      ),
    }
  }),
)

/**
 * The complete model tier: the router `LanguageModel`, the live
 * `ModelRegistry`, and the dynamic `LlmInfo`.
 */
export const ModelLive = Layer.mergeAll(RouterLanguageModelLive, LlmInfoLive)
  .pipe(Layer.provideMerge(ModelRegistryLive))
  .pipe(Layer.provide(FetchHttpClient.layer))

/**
 * The platform `HttpClient` layer, re-exported so driver packages that don't
 * depend on `@effect/platform` directly can satisfy HTTP-backed adapters.
 */
export const FetchHttpClientLive = FetchHttpClient.layer
