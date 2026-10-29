import { AiError, LanguageModel } from "effect/ai"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Clock, Config, Context, Duration, Effect, Layer, Metric, Option, Ref, Stream } from "effect"
import { AuthError, AuthStore, CurrentModelCallPolicy, CurrentTraceContent, describeModel, extractUsage, formatModelSelection, HarnessError, parseModelSelection, replayableContext, resolvingModel, SettingsStore } from "@xandreed/core"
import type { ModelSelection, TokenUsage } from "@xandreed/core"
import type { EngineSettings } from "@xandreed/core"
import { buildProvider, endpointOwnKey, prependClaudeCode, withAnthropicCacheBreakpoints } from "./providers.js"
import { CurrentOpenAiCodexSessions, makeOpenAiCodexSessions } from "./openAiCodexWebSocket.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
import { transportFetch } from "../transport/models-transport.adapter.js"
import {
  isTransientLlmError,
  rejectEmptyResponse,
  retryableLlm,
  retryableLlmStream,
} from "./retry.js"

/**
 * The routed `LanguageModel`: every call re-reads the settings selection and
 * resolves a key from the `AuthStore`, builds the provider's service for
 * exactly that call (`Effect.scoped`), and delegates — so a model switch or a
 * fresh login applies on the next turn with no rebuild. A turn's step
 * resolves the selection once (`resolveModelRequest`): its request header
 * and every attempt of the step, a stream's fallback included, use that
 * selection, and a switch applies from the next step. Each call rides the
 * timeout + transient-retry + empty-response guards from `retry.ts`.
 */

const configError = (message: string): AiError.AiError =>
  AiError.make({ module: "Router", method: "selection", reason: new AiError.UnknownError({ description: message }) })

/**
 * The routed-call metrics — every LLM request crosses this seam, so this is
 * the ONE place tokens and latency are counted. Tagged per resolved model;
 * exported by `TracingLive`'s metric reader (Prometheus: `llm_usage_*_total`,
 * `llm_request_duration_*`, `llm_requests_total` by outcome). The input
 * counter holds the full input (cache reads and writes inside it), the
 * output counter the full output (reasoning inside it); the cache and
 * reasoning counters are those shares.
 */
const llmInputTokens = Metric.counter("llm.usage.input_tokens", {
  description: "prompt tokens consumed by routed LLM calls",
  incremental: true,
})
const llmOutputTokens = Metric.counter("llm.usage.output_tokens", {
  description: "completion tokens produced by routed LLM calls",
  incremental: true,
})
const llmCacheReadTokens = Metric.counter("llm.usage.cache_read_tokens", {
  description: "prompt tokens of routed LLM calls read from the provider's prompt cache",
  incremental: true,
})
const llmCacheWriteTokens = Metric.counter("llm.usage.cache_write_tokens", {
  description: "prompt tokens of routed LLM calls written to the provider's prompt cache",
  incremental: true,
})
const llmReasoningTokens = Metric.counter("llm.usage.reasoning_tokens", {
  description: "completion tokens of routed LLM calls spent on reasoning",
  incremental: true,
})
const llmRequests = Metric.counter("llm.requests", {
  description: "routed LLM calls by final outcome (after retries)",
  incremental: true,
})
/** Wall-clock per routed call INCLUDING retries, in millisecond buckets
 *  spanning a fast cached turn (100ms) to the 300s request timeout. */
const llmDuration = Metric.timer("llm.request.duration", {
  boundaries: [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000],
})

const byModel = <Input, State>(
  metric: Metric.Metric<Input, State>,
  label: string,
): Metric.Metric<Input, State> => Metric.withAttributes(metric, { "llm.model": label })

/** One routed call's outcome, per model and rung. */
const countRequest = (label: string, outcome: "ok" | "error", isFallback?: boolean) =>
  Metric.update(
    Metric.withAttributes(byModel(llmRequests, label), {
      outcome,
      ...(isFallback === undefined ? {} : { fallback: isFallback ? "true" : "false" }),
    }),
    1,
  )

/** Effect's usage, read as the step loop reads it (`extractUsage`): every count of the call. */
const usageOf = (usage: unknown): TokenUsage => extractUsage(usage, [])

/** A call's usage as span attributes, named as its counters. */
const usageAttributes = (usage: TokenUsage) => ({
  "llm.usage.input_tokens": usage.inputTokens,
  "llm.usage.output_tokens": usage.outputTokens,
  "llm.usage.cache_read_tokens": usage.cacheReadTokens,
  "llm.usage.cache_write_tokens": usage.cacheWriteTokens,
  "llm.usage.reasoning_tokens": usage.reasoningTokens,
})

/** A call's usage added to the per-model token counters. */
const countUsage = (label: string, usage: TokenUsage) =>
  Effect.all(
    [
      Metric.update(byModel(llmInputTokens, label), usage.inputTokens),
      Metric.update(byModel(llmOutputTokens, label), usage.outputTokens),
      Metric.update(byModel(llmCacheReadTokens, label), usage.cacheReadTokens),
      Metric.update(byModel(llmCacheWriteTokens, label), usage.cacheWriteTokens),
      Metric.update(byModel(llmReasoningTokens, label), usage.reasoningTokens),
    ],
    { concurrency: 1, discard: true },
  )

/**
 * `EFFERENT_TRACE_CONTENT=1`, read with `Config` (the current ConfigProvider);
 * a provider that cannot be read counts as unset, with a warning.
 */
const traceContentVariable: Effect.Effect<boolean> = Config.option(Config.String("EFFERENT_TRACE_CONTENT")).pipe(
  Effect.map(Option.exists((value) => value === "1")),
  Effect.catch((error) => Effect.logWarning(`EFFERENT_TRACE_CONTENT cannot be read: ${error.message}`).pipe(Effect.as(false))),
)

/**
 * The model's reasoning on the call's span: its first 500 characters when
 * this call may carry content (`CurrentTraceContent`, which the step loop
 * provides from the run's `captureTraceContent`, or `EFFERENT_TRACE_CONTENT=1`
 * for the whole process), `[redacted]` otherwise. Read per call.
 */
const tracedContent = Effect.all([Effect.service(CurrentTraceContent), traceContentVariable], { concurrency: 1 }).pipe(Effect.map(([capture, variable]) =>
  (content: string): string => capture || variable ? content.slice(0, 500) : "[redacted]"))

const shapeOptions = (
  selection: ModelSelection,
  shouldPrependClaudeCode: boolean,
  options: unknown,
): unknown => {
  const cached =
    selection.provider === "anthropic" ? withAnthropicCacheBreakpoints(options) : options
  return shouldPrependClaudeCode ? prependClaudeCode(cached) : cached
}

/** Resolve the general-role selection from settings, plus the OPTIONAL
 *  fallback rung (an unparseable fallbackModel is ignored, never fatal —
 *  the primary path must not die on a typo'd safety net). */
const currentSelection = Effect.gen(function* () {
  const settings = yield* SettingsStore
  const loaded = yield* settings.load.pipe(
    Effect.mapError((e) => configError(`settings load failed: ${e.message}`)),
  )
  const raw = Option.getOrElse(loaded.model, () => "")
  const primary = yield* Option.match(parseModelSelection(raw), {
    onNone: () =>
      Effect.fail(
        configError(
          raw.length === 0
            ? `no model configured — set the models plugin's model option, or a SettingsStore model, to "<provider>:<modelId>"`
            : `the configured model "${raw}" is not a "<provider>:<modelId>" selection`,
        ),
      ),
    onSome: Effect.succeed,
  })
  return {
    primary,
    fallback: Option.flatMap(loaded.fallbackModel, parseModelSelection),
    effort: loaded.reasoningEffort,
  }
})

/** Apply the persisted model effort only when a dedicated agent has not
 * already pinned a complete call policy in its own execution profile. */
export const withConfiguredEffort = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  effort: EngineSettings["reasoningEffort"],
): Effect.Effect<A, E, R> =>
  Effect.service(CurrentModelCallPolicy).pipe(
    Effect.flatMap((current) =>
      Option.isSome(current) || Option.isNone(effort)
        ? effect
        : effect.pipe(
            Effect.provideService(
              CurrentModelCallPolicy,
              Option.some({ effort: effort.value }),
            ),
          ),
    ),
)

/** Requested routing profile, before explicit fallback/retry policy chooses a transport attempt. */
const describeSelection = (primary: ModelSelection, fallback: Option.Option<ModelSelection>, effort: EngineSettings["reasoningEffort"]) =>
  Effect.service(CurrentModelCallPolicy).pipe(Effect.map((current) => ({
    provider: primary.provider,
    model: primary.modelId,
    settings: {
      fallback: Option.getOrElse(Option.map(fallback, formatModelSelection), () => null),
      policy: Option.getOrElse(Option.orElse(current, () => Option.map(effort, (value) => ({ effort: value }))), () => null),
    },
  })))

/**
 * The credential and key one call uses. An endpoint with its own key
 * (`apiKey`, or a set `apiKeyEnv`) uses it and never reads the AuthStore; an
 * empty own key sends none. Every other selection reads the AuthStore, which
 * refreshes a near-expiry OAuth token first.
 */
const credentialFor = (selection: ModelSelection) => Effect.gen(function* () {
  const endpoints = yield* Effect.service(CurrentModelEndpoints)
  const own = yield* Option.match(Option.fromNullishOr(endpoints[selection.provider]), {
    onNone: () => Effect.succeedNone,
    onSome: (endpoint) => endpointOwnKey(endpoint).pipe(
      Effect.mapError((error) => new AuthError({ provider: selection.provider, message: `cannot read the endpoint's key variable: ${error.message}` })),
    ),
  })
  if (Option.isSome(own)) return { credential: undefined, key: own.value }
  const auth = yield* AuthStore
  return {
    credential: Option.getOrUndefined(yield* auth.get(selection.provider)),
    key: Option.getOrUndefined(yield* auth.resolveKey(selection.provider)),
  }
})

/**
 * A credential the call cannot have (none stored, a refresh that failed, a
 * route the transport refuses), as the `AiError` the `LanguageModel` port
 * fails with: an `AuthenticationError`, which is not retried and does not
 * fall back.
 */
const authenticationFailure = (error: AuthError): AiError.AiError =>
  AiError.make({
    module: "Router",
    method: "credentials",
    reason: new AiError.AuthenticationError({ kind: "Unknown", description: error.message, metadata: { router: { provider: error.provider } } }),
  })

/** The provider one call goes to, built over its credential. */
const providerFor = (selection: ModelSelection) =>
  credentialFor(selection).pipe(
    Effect.flatMap(({ credential, key }) => buildProvider(selection, credential, key)),
    Effect.mapError(authenticationFailure),
  )

/** A settled call's counters, duration and span, as every routed call records them. */
const recorded = (label: string, isFallback: boolean) =>
  <A extends { readonly usage: unknown }, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    call.pipe(
      Effect.tap((res) => countUsage(label, usageOf(res.usage))),
      Effect.tap(() => countRequest(label, "ok", isFallback)),
      Effect.tapError(() => countRequest(label, "error", isFallback)),
      // Duration of successful calls only, as before.
      Effect.timed,
      Effect.tap(([duration]) => Metric.update(byModel(llmDuration, label), duration)),
      Effect.map(([, res]) => res),
      Effect.withSpan("providers.generate", {
        attributes: { "llm.model": label },
      }),
    )

/** Build + call one provider generateText for an explicit selection.
 *  `isFallback` only labels telemetry — the fallback rung must be visible
 *  in Grafana without changing the metric identities. */
export const generateWith = (
  selection: ModelSelection,
  options: unknown,
  isFallback = false,
): Effect.Effect<
  { readonly content: ReadonlyArray<unknown>; readonly usage: unknown },
  AiError.AiError,
  AuthStore | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const label = formatModelSelection(selection)
    const traced = yield* tracedContent
    const built = yield* providerFor(selection)
    return yield* (
      built.svc.generateText(
        shapeOptions(selection, built.prependClaudeCode, options) as never,
      ) as Effect.Effect<{
        readonly content: ReadonlyArray<unknown>
        readonly usage: unknown
      }, AiError.AiError>
    ).pipe(
      rejectEmptyResponse(label),
      retryableLlm(label),
      Effect.map((res) => stampResponse(res, label)),
      // The span carries the WHOLE turn: what finished, what it cost, and
      // the (clipped) thinking — a trace answers "what did the model do"
      // without opening the conversation db.
      Effect.tap((res) =>
        Effect.annotateCurrentSpan({
          "llm.finish_reason": String(res.finishReason),
          ...usageAttributes(usageOf(res.usage)),
          "llm.response_chars": res.text.length,
          "llm.tool_calls": res.content
            .flatMap((part) => {
              const p = part as { readonly type?: string; readonly name?: string }
              return p.type === "tool-call" ? [p.name ?? ""] : []
            })
            .join(","),
          "llm.reasoning": traced(res.reasoningText ?? ""),
          "llm.fallback": isFallback,
        }),
      ),
      recorded(label, isFallback),
    )
  }).pipe(Effect.scoped)

/** Build + call one provider generateObject for an explicit selection: the
 *  resolution, option shaping, retries and telemetry of {@link generateWith}
 *  (an object has no empty response to reject and no message to stamp). */
export const objectWith = (
  selection: ModelSelection,
  options: unknown,
  isFallback = false,
): Effect.Effect<LanguageModel.GenerateObjectResponse<{}, unknown>, AiError.AiError, AuthStore | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const label = formatModelSelection(selection)
    const built = yield* providerFor(selection)
    // The schema's decoding services are the caller's, erased with its options.
    const call: Effect.Effect<LanguageModel.GenerateObjectResponse<{}, unknown>, AiError.AiError> = built.svc.generateObject(
      shapeOptions(selection, built.prependClaudeCode, options) as never,
    ) as never
    return yield* call.pipe(
      retryableLlm(label),
      Effect.tap((res) =>
        Effect.annotateCurrentSpan({
          "llm.finish_reason": String(res.finishReason),
          ...usageAttributes(usageOf(res.usage)),
          "llm.fallback": isFallback,
        }),
      ),
      recorded(label, isFallback),
    )
  }).pipe(Effect.scoped)

/**
 * The fallback rung: run the primary; if it fails TRANSIENT after the fast
 * retries exhausted and a DIFFERENT fallback selection is configured, run
 * the call once more there. Permanent errors (bad request, decode) pass
 * through — a fallback can't fix those; an unset or identical fallback is a
 * no-op. Exported pure-in-shape so the rung's decision table is testable
 * without building providers.
 */
export const withFallbackRung = <A, E, R>(
  primary: ModelSelection,
  fallback: Option.Option<ModelSelection>,
  call: (selection: ModelSelection, isFallback: boolean) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  call(primary, false).pipe(
    Effect.catch((error) =>
      Effect.flatMap(isTransientLlmError(error), (transient) =>
        Option.match(
          Option.filter(fallback, (fb) => transient && formatModelSelection(fb) !== formatModelSelection(primary)),
          {
            onNone: () => Effect.fail(error),
            onSome: (fb) =>
              Effect.logWarning(
                `${formatModelSelection(primary)} exhausted retries (${String(error).slice(0, 200)}) — falling back to ${formatModelSelection(fb)}`,
              ).pipe(Effect.andThen(call(fb, true))),
          },
        ),
      ),
    ),
  )

const stampModel = (part: unknown, label: string): unknown => {
  if (typeof part !== "object" || part === null) return part
  const p = part as { readonly type?: unknown; readonly metadata?: unknown }
  if (p.type !== "finish") return part
  const metadata =
    typeof p.metadata === "object" && p.metadata !== null
      ? (p.metadata as Record<string, unknown>)
      : {}
  return { ...p, metadata: { ...metadata, router: { model: label } } }
}

/**
 * Stamp the RESOLVED selection onto the finish part — the trail must answer
 * "which model produced this message" from the db alone. The response MUST be
 * rebuilt as a real `GenerateTextResponse`: it's a class whose
 * text/finishReason/usage are prototype GETTERS, so a `{...res}` spread
 * silently strips them — finishReason read as undefined and the loop treated
 * every tool turn as "done" (the one-tool-call-then-dead bug, live-caught).
 */
export const stampResponse = (
  res: { readonly content: ReadonlyArray<unknown> },
  label: string,
): LanguageModel.GenerateTextResponse<never> =>
  new LanguageModel.GenerateTextResponse(
    res.content.map((part) => stampModel(part, label)) as never,
  )

/** What the stream telemetry accumulates while parts flow — exactly the
 *  facts `generateWith` reads off the settled response. */
interface StreamStats {
  readonly textChars: number
  readonly reasoning: string
  readonly toolNames: ReadonlyArray<string>
}

const accumulateStats = (stats: StreamStats, part: unknown): StreamStats => {
  const p = part as {
    readonly type?: string
    readonly delta?: string
    readonly name?: string
  }
  if (p.type === "text-delta") {
    return { ...stats, textChars: stats.textChars + (p.delta ?? "").length }
  }
  if (p.type === "reasoning-delta") {
    return { ...stats, reasoning: stats.reasoning + (p.delta ?? "") }
  }
  if (p.type === "tool-call") {
    return { ...stats, toolNames: [...stats.toolNames, p.name ?? ""] }
  }
  return stats
}

/**
 * The stream twin of `generateWith`'s telemetry: accumulate over the flowing
 * parts, and when the finish part passes, write the SAME span attributes and
 * token counters a settled call would — byte-identical values on identical
 * content. Outcome + duration finalize per terminal state (`onDone` /
 * `tapErrorCause`), so retries inside count once, like the settled path.
 */
export const tapStreamTelemetry =
  (label: string) =>
  <E, R>(stream: Stream.Stream<unknown, E, R>): Stream.Stream<unknown, E, R> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const stats = yield* Ref.make<StreamStats>({
          textChars: 0,
          reasoning: "",
          toolNames: [],
        })
        const startedAt = yield* Clock.currentTimeMillis
        const traced = yield* tracedContent
        const recordDuration = Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Metric.update(byModel(llmDuration, label), Duration.millis(now - startedAt)),
          ),
        )
        return stream.pipe(
          Stream.mapEffect((part) => {
            const p = part as {
              readonly type?: string
              readonly reason?: string
              readonly usage?: unknown
            }
            if (p.type !== "finish") {
              return Ref.update(stats, (s) => accumulateStats(s, part)).pipe(Effect.as(part))
            }
            return Ref.get(stats).pipe(
              Effect.flatMap((s) =>
                Effect.annotateCurrentSpan({
                  "llm.finish_reason": String(p.reason),
                  ...usageAttributes(usageOf(p.usage)),
                  "llm.response_chars": s.textChars,
                  "llm.tool_calls": s.toolNames.join(","),
                  "llm.reasoning": traced(s.reasoning),
                }),
              ),
              Effect.andThen(countUsage(label, usageOf(p.usage))),
              Effect.as(part),
            )
          }),
          Stream.onEnd(countRequest(label, "ok").pipe(Effect.andThen(recordDuration))),
          Stream.tapCause(() => countRequest(label, "error").pipe(Effect.andThen(recordDuration))),
        )
      }),
    )

/** Build + call one provider streamText for an explicit selection — the
 *  stream twin of {@link generateWith}: same resolution, same option
 *  shaping (anthropic cache breakpoints inherit for free), same stamp, the
 *  stream-aware retry, and finish-part telemetry. */
export const streamWith = (
  selection: ModelSelection,
  options: unknown,
): Stream.Stream<unknown, AiError.AiError, AuthStore | HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const label = formatModelSelection(selection)
      const built = yield* providerFor(selection)
      return (
        built.svc.streamText(
          shapeOptions(selection, built.prependClaudeCode, options) as never,
        ) as Stream.Stream<unknown, AiError.AiError>
      ).pipe(
        retryableLlmStream(label),
        Stream.map((part) => stampModel(part, label)),
        tapStreamTelemetry(label),
        Stream.withSpan("providers.generate", {
          attributes: { "llm.model": label },
        }),
      )
    }),
  )

/** The persisted effort applies to a stream's whole run, unless a policy is already pinned. */
const withConfiguredEffortStream = <A, E, R>(
  stream: Stream.Stream<A, E, R>,
  effort: EngineSettings["reasoningEffort"],
): Stream.Stream<A, E, R> =>
  Stream.unwrap(Effect.service(CurrentModelCallPolicy).pipe(Effect.map((current) =>
    Option.isSome(current) || Option.isNone(effort)
      ? stream
      : stream.pipe(Stream.provideService(CurrentModelCallPolicy, Option.some({ effort: effort.value }))),
  )))

/**
 * The fetch the SDK providers' HTTP client uses on a call: the
 * `ModelsTransport`'s (which knows the proxy), when the model was built over
 * one. It is provided innermost, inside the replayed build context, so a
 * `FetchHttpClient.Fetch` in that context or around the call cannot send the
 * call past the proxy. Without a transport the call keeps whatever fetch is
 * in force, the global one by default.
 */
export const transportFetchOf = Effect.map(Effect.serviceOption(ModelsTransport), Option.map(transportFetch))

const withFetch = (fetch: Option.Option<typeof globalThis.fetch>) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Option.match(fetch, { onNone: () => effect, onSome: (value) => Effect.provideService(effect, FetchHttpClient.Fetch, value) })

const withFetchStream = (fetch: Option.Option<typeof globalThis.fetch>) => <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
  Option.match(fetch, { onNone: () => stream, onSome: (value) => Stream.provideService(stream, FetchHttpClient.Fetch, value) })

/**
 * A layer's calls' context with the layer's own OpenAI subscription session
 * cache (`CurrentOpenAiCodexSessions`): each conversation keeps its session
 * id while the layer lives, bounded to the conversations used last, and two
 * layers (two agents in one process) never share one.
 */
export const withCodexSessions = <R>(context: Context.Context<R>): Effect.Effect<Context.Context<R>> =>
  Effect.map(makeOpenAiCodexSessions(), (sessions) => Context.add(context, CurrentOpenAiCodexSessions, Option.some(sessions)))

/** The routed model of one selection: its fallback rung, the persisted effort, described as requested. */
const selectionModel = (
  primary: ModelSelection,
  fallback: Option.Option<ModelSelection>,
  effort: EngineSettings["reasoningEffort"],
  context: Context.Context<AuthStore>,
  http: HttpClient.HttpClient,
  fetch: Option.Option<typeof globalThis.fetch>,
): LanguageModel.LanguageModel => {
  const service = {
    [LanguageModel.TypeId]: LanguageModel.TypeId,
    generateText: (options: unknown) =>
      withConfiguredEffort(
        withFallbackRung(primary, fallback, (selection, isFallback) => generateWith(selection, options, isFallback)),
        effort,
      ).pipe(
        withFetch(fetch),
        Effect.provide(context),
        Effect.provideService(HttpClient.HttpClient, http),
      ) as never,
    generateObject: ((options: unknown) =>
      withConfiguredEffort(
        withFallbackRung(primary, fallback, (selection, isFallback) => objectWith(selection, options, isFallback)),
        effort,
      ).pipe(
        withFetch(fetch),
        Effect.provide(context),
        Effect.provideService(HttpClient.HttpClient, http),
      )) as never,
    // No stream-level fallback rung: a pre-first-part stream failure
    // already falls back to generateText in the engine loop, and THAT
    // call rides this router's fallback — one rung, no double-hop.
    streamText: ((options: unknown) =>
      withConfiguredEffortStream(streamWith(primary, options), effort).pipe(
        withFetchStream(fetch),
        Stream.provideContext(context),
        Stream.provideService(HttpClient.HttpClient, http),
      )) as never,
  } satisfies LanguageModel.LanguageModel
  return describeModel(service, describeSelection(primary, fallback, effort))
}

/**
 * `LanguageModelLive` — the engine loop's `LanguageModel`, routed per call.
 * Requires `SettingsStore` + `AuthStore`; brings its own fetch-backed
 * `HttpClient` so drivers don't have to. Built over a `ModelsTransport`
 * (as the models plugin builds it), every call goes through that transport.
 */
export const LanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    // Replayed on every call: without the span where the layer was built, so a call's spans nest where it runs.
    // The subscription's session ids are the layer's own (`withCodexSessions`).
    const context = yield* withCodexSessions(replayableContext(yield* Effect.context<AuthStore | SettingsStore>()))
    const http = yield* HttpClient.HttpClient
    const fetch = yield* transportFetchOf
    // One settings read: the model of the selection it finds.
    const selected = currentSelection.pipe(
      Effect.map(({ primary, fallback, effort }) => selectionModel(primary, fallback, effort, context, http, fetch)),
      Effect.provide(context),
    )
    const service: LanguageModel.LanguageModel = {
      [LanguageModel.TypeId]: LanguageModel.TypeId,
      generateText: (options: unknown) =>
        selected.pipe(Effect.flatMap((model) => model.generateText(options as never))) as never,
      generateObject: ((options: unknown) =>
        selected.pipe(Effect.flatMap((model) => model.generateObject(options as never)))) as never,
      streamText: ((options: unknown) =>
        Stream.unwrap(selected.pipe(Effect.map((model) => model.streamText(options as never))))) as never,
    }
    const asHarness = (error: AiError.AiError) => new HarnessError({ code: "request.model", message: String(error) })
    return resolvingModel(
      describeModel(service, currentSelection.pipe(
        Effect.flatMap(({ primary, fallback, effort }) => describeSelection(primary, fallback, effort)),
        Effect.provide(context),
        Effect.mapError(asHarness),
      )),
      selected.pipe(Effect.mapError(asHarness)),
    )
  }),
).pipe(Layer.provide(FetchHttpClient.layer))

/** A profile-pinned routed model. Unlike LanguageModelLive it never consults
 * SettingsStore; dedicated agents use this so global role edits cannot
 * silently change an evalled execution profile. */
export const LanguageModelSelectionLive = (
  primary: ModelSelection,
  fallback: Option.Option<ModelSelection>,
) => Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    // Replayed on every call: without the span where the layer was built, so a call's spans nest where it runs.
    const context = yield* withCodexSessions(replayableContext(yield* Effect.context<AuthStore>()))
    const http = yield* HttpClient.HttpClient
    return selectionModel(primary, fallback, Option.none(), context, http, yield* transportFetchOf)
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
