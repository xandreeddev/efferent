import { AiError, LanguageModel } from "effect/ai"
import type { Response, Tool, Toolkit } from "effect/ai"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Cause, Clock, Config, Context, Deferred, Duration, Effect, Layer, Metric, Option, Predicate, Ref, References, Stream } from "effect"
import { CurrentModelCallPolicy, CurrentTraceContent, describeModel, formatModelSelection, harnessError, parseModelSelection, reasonOf, resolvingModel, stampPartModel, stampResponseModel, storedJson } from "@xandreed/core"
import { AuthError, AuthStore, SettingsStore } from "@xandreed/core/models"
import { extractUsage } from "@xandreed/core/internal"
import type { ModelSelection, TokenUsage } from "@xandreed/core"
import type { EngineSettings } from "@xandreed/core/models"
import { buildProviderOver, endpointOwnKey, prependClaudeCode, providerServices, withAnthropicCacheBreakpoints } from "./providers.js"
import type { BuiltProvider, PromptOptions, ProviderServices } from "./providers.js"
import { makeOpenAiCodexSessions } from "./openAiCodexWebSocket.js"
import type { ModelEndpoints } from "../ports/model-endpoints.port.js"
import { transportFetch } from "../transport/models-transport.adapter.js"
import {
  canTryAgain,
  makeCallBudget,
  rejectEmptyResponse,
  retryableLlm,
  retryableLlmStream,
} from "./retry.js"
import type { CallBudget } from "./retry.js"

/**
 * The routed `LanguageModel`: every call re-reads the settings selection and
 * resolves a key from the `AuthStore`, builds the provider's service for
 * exactly that call (`Effect.scoped`), and delegates — so a model switch or a
 * fresh login applies on the next turn with no rebuild. A turn's step
 * resolves the selection once (`resolveModelRequest`): its request header
 * and every attempt of the step, a stream's fallback included, use that
 * selection, and a switch applies from the next step. Each call rides the
 * timeout + transient-retry + empty-response guards from `retry.ts`; a
 * call's attempts (a settled call's fallback rung too) share one
 * `CallBudget`, and the call is final once it hands a tool call to its
 * toolkit.
 *
 * A routed model reads what its calls are built over (the configured
 * endpoints, the transport, a subscription session cache of its own) once,
 * where its layer is built, and replays only its stores on a call: what a
 * call carries (its call policy, its prompt cache key, its trace state) is
 * the call's own.
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

/** A call's options as the built model takes them: Anthropic's route adds its cache breakpoints, the subscription's token the Claude Code block. */
const shapeOptions = <O extends PromptOptions>(built: BuiltProvider, options: O) => {
  const cached = built.route === "anthropic" ? withAnthropicCacheBreakpoints(options) : options
  return built.prependClaudeCode ? prependClaudeCode(cached) : cached
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

/** Requested routing profile, before explicit fallback/retry policy chooses a transport attempt. The
 *  call policy is recorded as JSON, as the request header stores it: a field it leaves unset is left out. */
const describeSelection = (primary: ModelSelection, fallback: Option.Option<ModelSelection>, effort: EngineSettings["reasoningEffort"]) =>
  Effect.service(CurrentModelCallPolicy).pipe(Effect.flatMap((current) => storedJson({
    fallback: Option.getOrElse(Option.map(fallback, formatModelSelection), () => null),
    policy: Option.getOrElse(Option.orElse(current, () => Option.map(effort, (value) => ({ effort: value }))), () => null),
  })), Effect.mapBoth({
    onFailure: (error) => harnessError("request.model", `the routed model's settings are not JSON: ${error.message}`, error),
    onSuccess: (settings) => ({ provider: primary.provider, model: primary.modelId, settings }),
  }))

/**
 * The credential and key one call uses, under its `models.credentials` span.
 * An endpoint with its own key (`apiKey`, or a set `apiKeyEnv`) uses it and
 * never reads the AuthStore; an empty own key sends none. Every other
 * selection reads the AuthStore, which refreshes a near-expiry OAuth token
 * first.
 */
const credentialFor = Effect.fn("models.credentials")(function* (selection: ModelSelection, endpoints: ModelEndpoints) {
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

/** The provider one call goes to, built over its credential and the provider services. */
const providerFor = (selection: ModelSelection, services: ProviderServices) =>
  credentialFor(selection, services.endpoints).pipe(
    Effect.flatMap(({ credential, key }) => buildProviderOver(services)(selection, credential, key)),
    Effect.mapError(authenticationFailure),
  )

/** A settled call's counters and duration, as every routed call records them: the provider's call alone, its credential left out. */
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
    )

/** The model as the span attribute and the log annotation of everything one routed call does. */
const modelAttributes = (selection: ModelSelection) => ({ "llm.model": formatModelSelection(selection) })

/**
 * One routed call's `providers.generate` span, around all of it: its
 * credential (`models.credentials`), its provider's build and the call. The
 * call's logs carry its model.
 */
const providerCall = (selection: ModelSelection) =>
  <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    call.pipe(
      Effect.annotateLogs(modelAttributes(selection)),
      Effect.withSpan("providers.generate", { attributes: modelAttributes(selection) }),
    )

/** {@link providerCall} for a stream: the span and the annotations last while it runs. */
const providerStream = (selection: ModelSelection) =>
  <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
    stream.pipe(
      Stream.updateService(References.CurrentLogAnnotations, (annotations) => ({ ...annotations, ...modelAttributes(selection) })),
      Stream.withSpan("providers.generate", { attributes: modelAttributes(selection) }),
    )

const isToolkitWithHandler = (value: unknown): value is Toolkit.WithHandler<Record<string, Tool.Any>> =>
  Predicate.hasProperty(value, "tools") && Predicate.hasProperty(value, "handle") && Predicate.isFunction(value.handle)

/**
 * The toolkit, its every call first marking the routed call handed off, and
 * counted in `budget.inFlight` from then until its results end.
 */
const handingOff = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  budget: CallBudget,
): Toolkit.WithHandler<Tools> => ({
  tools: toolkit.tools,
  handle: (name, params, toolCallId, parseOptions) => {
    const ended = Ref.update(budget.inFlight, (running) => running - 1)
    // Counted and uncounted as a pair: interruption waits until the count
    // has its release attached, on the call or on its results.
    return Effect.uninterruptibleMask((restore) =>
      Deferred.succeed(budget.handedOff, undefined).pipe(
        Effect.andThen(Ref.update(budget.inFlight, (running) => running + 1)),
        Effect.andThen(restore(toolkit.handle(name, params, toolCallId, parseOptions)).pipe(Effect.onError(() => ended))),
        Effect.map(Stream.ensuring(ended)),
      ))
  },
})

/**
 * A call's options with its toolkit watched for the hand-off: the first tool
 * call it hands to the toolkit, which starts that tool's handler, completes
 * `budget.handedOff`, and the call is final from then on (`retryableLlm`,
 * `retryableLlmStream`, {@link withFallbackRung}); each handler counts in
 * `budget.inFlight` while it runs. A yieldable `Toolkit` is watched once it
 * resolves; options without a toolkit are returned as they are.
 */
export const withHandOff = <O extends PromptOptions>(options: O, budget: CallBudget): O => {
  if (!Predicate.hasProperty(options, "toolkit")) return options
  const toolkit = options.toolkit
  const watched = Effect.isEffect(toolkit)
    ? Effect.map(toolkit, (resolved) => isToolkitWithHandler(resolved) ? handingOff(resolved, budget) : resolved)
    : isToolkitWithHandler(toolkit) ? handingOff(toolkit, budget) : toolkit
  return { ...options, toolkit: watched }
}

/** One routed call's settled response, as {@link generateOver} returns it. */
type Generated = { readonly content: ReadonlyArray<unknown>; readonly usage: unknown }

/** Build + call one provider generateText for an explicit selection, over
 *  the given provider services (a routed model's, read where its layer was
 *  built). `isFallback` only labels telemetry — the fallback rung must be
 *  visible in Grafana without changing the metric identities. `budget` is
 *  the routed call's, shared with its fallback rung; a call made without
 *  one gets its own. */
export const generateOver = (services: ProviderServices) => <O extends PromptOptions>(
  selection: ModelSelection,
  options: O,
  isFallback = false,
  budget?: CallBudget,
): Effect.Effect<Generated, AiError.AiError, AuthStore | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const label = formatModelSelection(selection)
    const traced = yield* tracedContent
    const bound = budget ?? (yield* makeCallBudget())
    const built = yield* providerFor(selection, services)
    return yield* (
      built.svc.generateText(
        shapeOptions(built, withHandOff(options, bound)) as never,
      ) as Effect.Effect<{
        readonly content: ReadonlyArray<Response.AnyPart>
        readonly usage: unknown
      }, AiError.AiError>
    ).pipe(
      rejectEmptyResponse(label),
      retryableLlm(label, bound),
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
            .flatMap((part: Response.AnyPart) => part.type === "tool-call" ? [part.name] : [])
            .join(","),
          "llm.reasoning": traced(res.reasoningText ?? ""),
          "llm.fallback": isFallback,
        }),
      ),
      recorded(label, isFallback),
    )
  }).pipe(Effect.scoped, providerCall(selection))

/** {@link generateOver} over the provider services where it runs
 *  (`CurrentModelEndpoints`, `ModelsTransport`), for a call made outside a
 *  routed model. */
export const generateWith = <O extends PromptOptions>(
  selection: ModelSelection,
  options: O,
  isFallback = false,
  budget?: CallBudget,
): Effect.Effect<Generated, AiError.AiError, AuthStore | HttpClient.HttpClient> =>
  Effect.flatMap(providerServices, (services) => generateOver(services)(selection, options, isFallback, budget))

/** Build + call one provider generateObject for an explicit selection: the
 *  resolution, option shaping, budget, retries and telemetry of
 *  {@link generateOver} (an object has no empty response to reject and no
 *  message to stamp). */
const objectOver = (services: ProviderServices) => <O extends PromptOptions>(
  selection: ModelSelection,
  options: O,
  isFallback: boolean,
  budget: CallBudget,
): Effect.Effect<LanguageModel.GenerateObjectResponse<{}, unknown>, AiError.AiError, AuthStore | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const label = formatModelSelection(selection)
    const built = yield* providerFor(selection, services)
    // The schema's decoding services are the caller's, erased with its options.
    const call: Effect.Effect<LanguageModel.GenerateObjectResponse<{}, unknown>, AiError.AiError> = built.svc.generateObject(
      shapeOptions(built, withHandOff(options, budget)) as never,
    ) as never
    return yield* call.pipe(
      retryableLlm(label, budget),
      Effect.tap((res) =>
        Effect.annotateCurrentSpan({
          "llm.finish_reason": String(res.finishReason),
          ...usageAttributes(usageOf(res.usage)),
          "llm.fallback": isFallback,
        }),
      ),
      recorded(label, isFallback),
    )
  }).pipe(Effect.scoped, providerCall(selection))

/**
 * The fallback rung: run the primary; if it fails TRANSIENT after the fast
 * retries exhausted, while the call's budget may still try again (no tool
 * call handed off, its deadline not come: `canTryAgain`), and a DIFFERENT
 * fallback selection is configured, run the call once more there, within
 * the same budget. Permanent errors (bad request, decode) pass through — a
 * fallback can't fix those; an unset or identical fallback is a no-op.
 * Exported pure-in-shape so the rung's decision table is testable without
 * building providers.
 */
export const withFallbackRung = <A, E, R>(
  primary: ModelSelection,
  fallback: Option.Option<ModelSelection>,
  call: (selection: ModelSelection, isFallback: boolean) => Effect.Effect<A, E, R>,
  budget: CallBudget,
): Effect.Effect<A, E, R> =>
  call(primary, false).pipe(
    Effect.catch((error) =>
      Effect.flatMap(canTryAgain(budget)(error), (again) =>
        Option.match(
          Option.filter(fallback, (fb) => again && formatModelSelection(fb) !== formatModelSelection(primary)),
          {
            onNone: () => Effect.fail(error),
            onSome: (fb) =>
              Effect.logWarning(`exhausted retries (${String(error).slice(0, 200)}) — falling back`).pipe(
                Effect.annotateLogs({ ...modelAttributes(primary), "llm.fallback_model": formatModelSelection(fb) }),
                Effect.andThen(call(fb, true)),
              ),
          },
        ),
      ),
    ),
  )

/**
 * Stamp the RESOLVED selection onto the finish part (core's
 * `stampResponseModel`) — the trail must answer "which model produced this
 * message" from the db alone. The response MUST be
 * rebuilt as a real `GenerateTextResponse`: it's a class whose
 * text/finishReason/usage are prototype GETTERS, so a `{...res}` spread
 * silently strips them — finishReason read as undefined and the loop treated
 * every tool turn as "done" (the one-tool-call-then-dead bug, live-caught).
 */
export const stampResponse = (
  res: { readonly content: ReadonlyArray<Response.AnyPart> },
  label: string,
): LanguageModel.GenerateTextResponse<never> =>
  new LanguageModel.GenerateTextResponse(
    stampResponseModel(res.content, label) as never,
  )

/** What the stream telemetry accumulates while parts flow — exactly the
 *  facts `generateWith` reads off the settled response. */
interface StreamStats {
  readonly textChars: number
  readonly reasoning: string
  readonly toolNames: ReadonlyArray<string>
}

/** A stream part's field, read without trusting the part's shape: `undefined` when it has none. */
const fieldOf = (part: unknown, key: string): unknown => Predicate.hasProperty(part, key) ? part[key] : undefined

/** A stream part's text field, "" when it has none. */
const textOf = (part: unknown, key: string): string => {
  const value = fieldOf(part, key)
  return Predicate.isString(value) ? value : ""
}

const accumulateStats = (stats: StreamStats, part: unknown): StreamStats => {
  const type = textOf(part, "type")
  if (type === "text-delta") {
    return { ...stats, textChars: stats.textChars + textOf(part, "delta").length }
  }
  if (type === "reasoning-delta") {
    return { ...stats, reasoning: stats.reasoning + textOf(part, "delta") }
  }
  if (type === "tool-call") {
    return { ...stats, toolNames: [...stats.toolNames, textOf(part, "name")] }
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
  <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
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
            if (textOf(part, "type") !== "finish") {
              return Ref.update(stats, (s) => accumulateStats(s, part)).pipe(Effect.as(part))
            }
            const usage = usageOf(fieldOf(part, "usage"))
            return Ref.get(stats).pipe(
              Effect.flatMap((s) =>
                Effect.annotateCurrentSpan({
                  "llm.finish_reason": String(fieldOf(part, "reason")),
                  ...usageAttributes(usage),
                  "llm.response_chars": s.textChars,
                  "llm.tool_calls": s.toolNames.join(","),
                  "llm.reasoning": traced(s.reasoning),
                }),
              ),
              Effect.andThen(countUsage(label, usage)),
              Effect.as(part),
            )
          }),
          Stream.onEnd(countRequest(label, "ok").pipe(Effect.andThen(recordDuration))),
          Stream.tapCause(() => countRequest(label, "error").pipe(Effect.andThen(recordDuration))),
        )
      }),
    )

/** Build + call one provider streamText for an explicit selection — the
 *  stream twin of {@link generateOver}: same resolution, same option
 *  shaping (anthropic cache breakpoints inherit for free), same budget and
 *  hand-off, same stamp, the stream-aware retry, and finish-part telemetry. */
const streamOver = (services: ProviderServices) => <O extends PromptOptions>(
  selection: ModelSelection,
  options: O,
  budget: CallBudget,
): Stream.Stream<unknown, AiError.AiError, AuthStore | HttpClient.HttpClient> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const label = formatModelSelection(selection)
      const built = yield* providerFor(selection, services)
      return (
        built.svc.streamText(
          shapeOptions(built, withHandOff(options, budget)) as never,
        ) as Stream.Stream<Response.AnyPart, AiError.AiError>
      ).pipe(
        retryableLlmStream(label, budget),
        Stream.map((part) => stampPartModel(part, label)),
        tapStreamTelemetry(label),
      )
    }),
  ).pipe(providerStream(selection))

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
 * one. It is provided innermost, so a `FetchHttpClient.Fetch` around the
 * call cannot send the call past the proxy. Without a transport the call
 * keeps whatever fetch is in force, the global one by default.
 */
export const throughTransport = (services: ProviderServices) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Option.match(services.transport, { onNone: () => effect, onSome: (transport) => Effect.provideService(effect, FetchHttpClient.Fetch, transportFetch(transport)) })

/** {@link throughTransport} for a stream. */
const throughTransportStream = (services: ProviderServices) => <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
  Option.match(services.transport, { onNone: () => stream, onSome: (transport) => Stream.provideService(stream, FetchHttpClient.Fetch, transportFetch(transport)) })

/**
 * The provider services of a routed model's layer, read once where it is
 * built: the configured endpoints (`CurrentModelEndpoints`), the transport
 * (`ModelsTransport`), and an OpenAI subscription session cache of the
 * layer's own: each conversation keeps its session id while the layer
 * lives, bounded to the conversations used last, and two layers (two agents
 * in one process) never share one.
 */
export const layerProviderServices: Effect.Effect<ProviderServices> = Effect.all([providerServices, makeOpenAiCodexSessions()], { concurrency: 1 }).pipe(
  Effect.map(([services, sessions]) => ({ ...services, sessions: Option.some(sessions) })),
)

/** The routed model of one selection: its fallback rung, the persisted effort, described as requested. */
const selectionModel = (
  primary: ModelSelection,
  fallback: Option.Option<ModelSelection>,
  effort: EngineSettings["reasoningEffort"],
  stores: Context.Context<AuthStore>,
  http: HttpClient.HttpClient,
  services: ProviderServices,
): LanguageModel.LanguageModel => {
  // One budget per routed call, shared by its attempts and its fallback rung.
  // A stream's is made when it starts.
  const service = {
    [LanguageModel.TypeId]: LanguageModel.TypeId,
    generateText: (options: PromptOptions) =>
      makeCallBudget().pipe(
        Effect.flatMap((budget) => withConfiguredEffort(
          withFallbackRung(primary, fallback, (selection, isFallback) => generateOver(services)(selection, options, isFallback, budget), budget),
          effort,
        )),
        throughTransport(services),
        Effect.provide(stores),
        Effect.provideService(HttpClient.HttpClient, http),
      ) as never,
    generateObject: ((options: PromptOptions) =>
      makeCallBudget().pipe(
        Effect.flatMap((budget) => withConfiguredEffort(
          withFallbackRung(primary, fallback, (selection, isFallback) => objectOver(services)(selection, options, isFallback, budget), budget),
          effort,
        )),
        throughTransport(services),
        Effect.provide(stores),
        Effect.provideService(HttpClient.HttpClient, http),
      )) as never,
    // No stream-level fallback rung: a pre-first-part stream failure
    // already falls back to generateText in the engine loop, and THAT
    // call rides this router's fallback — one rung, no double-hop.
    streamText: ((options: PromptOptions) =>
      withConfiguredEffortStream(Stream.unwrap(Effect.map(makeCallBudget(), (budget) => streamOver(services)(primary, options, budget))), effort).pipe(
        throughTransportStream(services),
        Stream.provideContext(stores),
        Stream.provideService(HttpClient.HttpClient, http),
      )) as never,
  } satisfies LanguageModel.LanguageModel
  return describeModel(service, describeSelection(primary, fallback, effort))
}

/**
 * `LanguageModelLive` — the engine loop's `LanguageModel`, routed per call.
 * Requires `SettingsStore` + `AuthStore`; brings its own fetch-backed
 * `HttpClient` so drivers don't have to. Reads `CurrentModelEndpoints` and
 * `ModelsTransport` once, where it is built: built over a transport (as the
 * models plugin builds it), every call goes through that transport.
 */
export const LanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    // Replayed on every call: the stores alone, so a call's spans nest where it runs and its references are its own.
    const stores = Context.pick(AuthStore, SettingsStore)(yield* Effect.context<AuthStore | SettingsStore>())
    const services = yield* layerProviderServices
    const http = yield* HttpClient.HttpClient
    // One settings read: the model of the selection it finds.
    const selected = currentSelection.pipe(
      Effect.map(({ primary, fallback, effort }) => selectionModel(primary, fallback, effort, stores, http, services)),
      Effect.provide(stores),
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
    const asHarness = (error: AiError.AiError) => harnessError("request.model", reasonOf(Cause.fail(error)), error)
    return resolvingModel(
      describeModel(service, currentSelection.pipe(
        Effect.mapError(asHarness),
        Effect.flatMap(({ primary, fallback, effort }) => describeSelection(primary, fallback, effort)),
        Effect.provide(stores),
      )),
      selected.pipe(Effect.mapError(asHarness)),
    )
  }),
).pipe(Layer.provide(FetchHttpClient.layer))

/** A profile-pinned routed model. Unlike LanguageModelLive it never consults
 * SettingsStore; dedicated agents use this so global role edits cannot
 * silently change an evalled execution profile. Like it, it reads its
 * provider services once, where it is built. */
export const LanguageModelSelectionLive = (
  primary: ModelSelection,
  fallback: Option.Option<ModelSelection>,
) => Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    // Replayed on every call: the store alone, so a call's spans nest where it runs and its references are its own.
    const stores = Context.pick(AuthStore)(yield* Effect.context<AuthStore>())
    const http = yield* HttpClient.HttpClient
    return selectionModel(primary, fallback, Option.none(), stores, http, yield* layerProviderServices)
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
