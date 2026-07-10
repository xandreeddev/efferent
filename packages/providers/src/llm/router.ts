import { AiError, LanguageModel } from "@effect/ai"
import { FetchHttpClient, HttpClient } from "@effect/platform"
import { Clock, Duration, Effect, Layer, Metric, Option, Ref, Stream } from "effect"
import {
  AuthStore,
  formatModelSelection,
  parseModelSelection,
  SettingsStore,
} from "@xandreed/engine"
import type { ModelSelection } from "@xandreed/engine"
import { buildProvider, prependClaudeCode, withAnthropicCacheBreakpoints } from "./providers.js"
import { rejectEmptyResponse, retryableLlm, retryableLlmStream } from "./retry.js"

/**
 * The routed `LanguageModel`: every call re-reads the settings selection and
 * resolves a key from the `AuthStore`, builds the provider's service for
 * exactly that call (`Effect.scoped`), and delegates — so a model switch or a
 * fresh login applies on the next turn with no rebuild. Each call rides the
 * timeout + transient-retry + empty-response guards from `retry.ts`.
 */

const configError = (message: string): AiError.UnknownError =>
  new AiError.UnknownError({ module: "Router", method: "selection", description: message })

/**
 * The routed-call metrics — every LLM request crosses this seam, so this is
 * the ONE place tokens and latency are counted. Tagged per resolved model;
 * exported by `TracingLive`'s metric reader (Prometheus: `llm_usage_*_total`,
 * `llm_request_duration_*`, `llm_requests_total` by outcome).
 */
const llmInputTokens = Metric.counter("llm.usage.input_tokens", {
  description: "prompt tokens consumed by routed LLM calls",
  incremental: true,
})
const llmOutputTokens = Metric.counter("llm.usage.output_tokens", {
  description: "completion tokens produced by routed LLM calls",
  incremental: true,
})
const llmRequests = Metric.counter("llm.requests", {
  description: "routed LLM calls by final outcome (after retries)",
  incremental: true,
})
/** Wall-clock per routed call INCLUDING retries, in millisecond buckets
 *  spanning a fast cached turn (100ms) to the 300s request timeout. */
const llmDuration = Metric.timerWithBoundaries(
  "llm.request.duration",
  [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000],
)

const byModel = <Type, In, Out>(
  metric: Metric.Metric<Type, In, Out>,
  label: string,
): Metric.Metric<Type, In, Out> => Metric.tagged(metric, "llm.model", label)

const shapeOptions = (
  selection: ModelSelection,
  shouldPrependClaudeCode: boolean,
  options: unknown,
): unknown => {
  const cached =
    selection.provider === "anthropic" ? withAnthropicCacheBreakpoints(options) : options
  return shouldPrependClaudeCode ? prependClaudeCode(cached) : cached
}

/** Resolve the general-role selection from settings. */
const currentSelection = Effect.gen(function* () {
  const settings = yield* SettingsStore
  const loaded = yield* settings.load.pipe(
    Effect.mapError((e) => configError(`settings load failed: ${e.message}`)),
  )
  const raw = Option.getOrElse(loaded.model, () => "")
  return yield* Option.match(parseModelSelection(raw), {
    onNone: () =>
      Effect.fail(
        configError(
          raw.length === 0
            ? `no model configured — set "model": "<provider>:<modelId>" in .efferent/config.json`
            : `the configured model "${raw}" is not a "<provider>:<modelId>" selection`,
        ),
      ),
    onSome: Effect.succeed,
  })
})

/** Build + call one provider generateText for an explicit selection. */
export const generateWith = (
  selection: ModelSelection,
  options: unknown,
): Effect.Effect<
  { readonly content: ReadonlyArray<unknown>; readonly usage: unknown },
  unknown,
  AuthStore | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const label = formatModelSelection(selection)
    const credential = Option.getOrUndefined(yield* auth.get(selection.provider))
    const key = Option.getOrUndefined(yield* auth.resolveKey(selection.provider))
    const built = yield* buildProvider(selection, credential, key)
    return yield* (
      built.svc.generateText(
        shapeOptions(selection, built.prependClaudeCode, options) as never,
      ) as Effect.Effect<{
        readonly content: ReadonlyArray<unknown>
        readonly usage: unknown
      }>
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
          "llm.usage.input_tokens": res.usage.inputTokens ?? 0,
          "llm.usage.output_tokens": res.usage.outputTokens ?? 0,
          "llm.response_chars": res.text.length,
          "llm.tool_calls": res.content
            .flatMap((part) => {
              const p = part as { readonly type?: string; readonly name?: string }
              return p.type === "tool-call" ? [p.name ?? ""] : []
            })
            .join(","),
          "llm.reasoning": (res.reasoningText ?? "").slice(0, 500),
        }),
      ),
      Effect.tap((res) =>
        Effect.all(
          [
            Metric.incrementBy(byModel(llmInputTokens, label), res.usage.inputTokens ?? 0),
            Metric.incrementBy(byModel(llmOutputTokens, label), res.usage.outputTokens ?? 0),
          ],
          { discard: true },
        ),
      ),
      Effect.tapBoth({
        onFailure: () =>
          Metric.increment(Metric.tagged(byModel(llmRequests, label), "outcome", "error")),
        onSuccess: () =>
          Metric.increment(Metric.tagged(byModel(llmRequests, label), "outcome", "ok")),
      }),
      Metric.trackDuration(byModel(llmDuration, label)),
      Effect.withSpan("providers.generate", {
        attributes: { "llm.model": label },
      }),
    )
  }).pipe(Effect.scoped)

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
              readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
            }
            if (p.type !== "finish") {
              return Ref.update(stats, (s) => accumulateStats(s, part)).pipe(Effect.as(part))
            }
            return Ref.get(stats).pipe(
              Effect.flatMap((s) =>
                Effect.annotateCurrentSpan({
                  "llm.finish_reason": String(p.reason),
                  "llm.usage.input_tokens": p.usage?.inputTokens ?? 0,
                  "llm.usage.output_tokens": p.usage?.outputTokens ?? 0,
                  "llm.response_chars": s.textChars,
                  "llm.tool_calls": s.toolNames.join(","),
                  "llm.reasoning": s.reasoning.slice(0, 500),
                }),
              ),
              Effect.zipRight(
                Effect.all(
                  [
                    Metric.incrementBy(byModel(llmInputTokens, label), p.usage?.inputTokens ?? 0),
                    Metric.incrementBy(
                      byModel(llmOutputTokens, label),
                      p.usage?.outputTokens ?? 0,
                    ),
                  ],
                  { discard: true },
                ),
              ),
              Effect.as(part),
            )
          }),
          Stream.onDone(() =>
            Metric.increment(Metric.tagged(byModel(llmRequests, label), "outcome", "ok")).pipe(
              Effect.zipRight(recordDuration),
            ),
          ),
          Stream.tapErrorCause(() =>
            Metric.increment(Metric.tagged(byModel(llmRequests, label), "outcome", "error")).pipe(
              Effect.zipRight(recordDuration),
            ),
          ),
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
): Stream.Stream<unknown, unknown, AuthStore | HttpClient.HttpClient> =>
  Stream.unwrapScoped(
    Effect.gen(function* () {
      const auth = yield* AuthStore
      const label = formatModelSelection(selection)
      const credential = Option.getOrUndefined(yield* auth.get(selection.provider))
      const key = Option.getOrUndefined(yield* auth.resolveKey(selection.provider))
      const built = yield* buildProvider(selection, credential, key)
      return (
        built.svc.streamText(
          shapeOptions(selection, built.prependClaudeCode, options) as never,
        ) as Stream.Stream<unknown, unknown>
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

/**
 * `LanguageModelLive` — the engine loop's `LanguageModel`, routed per call.
 * Requires `SettingsStore` + `AuthStore`; brings its own fetch-backed
 * `HttpClient` so drivers don't have to.
 */
export const LanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const context = yield* Effect.context<AuthStore | SettingsStore>()
    const http = yield* HttpClient.HttpClient

    const service: LanguageModel.Service = {
      generateText: (options) =>
        currentSelection.pipe(
          Effect.flatMap((selection) => generateWith(selection, options)),
          Effect.provide(context),
          Effect.provideService(HttpClient.HttpClient, http),
        ) as never,
      generateObject: (() =>
        Effect.fail(
          configError("generateObject is not wired on the new line yet"),
        )) as never,
      streamText: ((options: unknown) =>
        Stream.unwrap(
          currentSelection.pipe(
            Effect.map((selection) => streamWith(selection, options)),
          ),
        ).pipe(
          Stream.provideSomeContext(context),
          Stream.provideService(HttpClient.HttpClient, http),
        )) as never,
    }
    return service
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
