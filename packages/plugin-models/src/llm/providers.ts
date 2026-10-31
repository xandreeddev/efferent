import { AiError, LanguageModel, Prompt } from "effect/ai"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Config, Effect, Match, Metric, Option, Predicate, Redacted, Ref, Result, Stream } from "effect"
import type { Context, Schema, Scope } from "effect"
import { isTurnError, CurrentModelCallPolicy, CurrentPromptCacheKey, describeModel, formatModelSelection, modelRequestDescriptorOf } from "@xandreed/core"
import { isVolatileContext, stripVolatileContext } from "@xandreed/core/internal"
import { CurrentPromptCacheFrame } from "../ports/prompt-cache-frame.port.js"
import { PromptCacheError } from "./prompt-cache.entity.js"
import type { CachePosition, PromptCacheControl, PromptCacheSettings } from "./prompt-cache.entity.js"
import type { PromptCacheFrame } from "./prompt-cache-frame.entity.js"
import { planBreakpoints } from "./prompt-cache.entity.functions.js"
import { AuthError } from "../ports/auth-store.port.js"
import type { ModelCallPolicy, ModelSelection } from "@xandreed/core"
import type { Credential } from "../ports/auth-store.port.js"
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM } from "../auth/anthropicOAuth.js"
import { makeCompatLanguageModel, promptWithImageLabels } from "./compat.js"
import { publicReasoningEffort, usesOpenCodeResponses } from "./modelCatalog.js"
import { makeOpenAiCodexLanguageModel, OPENAI_CODEX_API_URL } from "./openAiCodex.js"
import { CurrentOpenAiCodexSessions } from "./openAiCodexWebSocket.js"
import type { OpenAiCodexSessions } from "./openAiCodexWebSocket.js"
import { BuiltInProvider } from "./provider-profile.entity.js"
import type { ChatRoute, ModelProfile, ResponsesRoute, Route } from "./provider-profile.entity.js"
import { anthropicProfileOf, profileOf } from "./provider-profile.entity.functions.js"
import { openAiCodexAccountId } from "../auth/openAiCodexOAuth.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelEndpoint, ModelEndpoints } from "../ports/model-endpoints.port.js"
import { CurrentManagedModelsTransport, ModelsTransport } from "../ports/models-transport.port.js"
import type { WebSocketProxy } from "../ports/models-transport.port.js"
import { CurrentModelSettings } from "../ports/model-settings.port.js"
import { ModelSettingsError, ModelThinking } from "./model-settings.entity.js"
import type { ModelSettingsMap, ResolvedAnthropicSettings } from "./model-settings.entity.js"
import { resolveAnthropicSettings, validateAnthropicRequest } from "./model-settings.entity.functions.js"
import { CurrentThinkingPrefixMismatch } from "../ports/thinking-binding.port.js"
import { THINKING_BINDING_BETA } from "./thinking-binding.entity.js"
import type { ThinkingPrefixMismatch } from "./thinking-binding.entity.js"
import { bindingFor, droppedInBody, droppedInMessageStart, firstEventData, mergeBetas } from "./thinking-binding.entity.functions.js"
import { classifyAiError } from "./provider-failure.entity.functions.js"
import { providerFailureProtocol, withAnthropicFailures, withOpenAiFailures } from "./provider-client.adapter.js"
import type { ProviderFailureProtocol } from "./provider-failure.entity.js"
import { retainModelAttempt } from "./model-completion.adapter.js"
import { resilientHttpClient, withModelRequestCall, withModelRequestStream } from "../transport/resilient-http-client.adapter.js"

/**
 * Per-provider `LanguageModel` construction. Built PER REQUEST from a
 * freshly-resolved key (never captured at layer build), so a credential or
 * model switch applies on the next call.
 *
 * The built-in providers are their profiles (`PROVIDER_PROFILES`): opencode
 * (OpenAI-compatible gateway — the default), google (Gemini's
 * OpenAI-compatible endpoint), anthropic (api key or subscription OAuth),
 * openai (api key), openai-codex (subscription OAuth). A model is built by
 * its route, one builder each. A configured endpoint, or a `local`
 * credential with a `baseUrl`, sends its provider's models to that
 * OpenAI-compatible URL, with or without a key.
 */

export { GOOGLE_CHAT_URL, OPENCODE_CHAT_URL, OPENCODE_RESPONSES_API_URL } from "./provider-profile.entity.functions.js"

export { usesOpenCodeResponses }

export interface BuiltProvider {
  readonly svc: LanguageModel.LanguageModel
  /** Anthropic subscription auth requires the Claude Code system block first. */
  readonly prependClaudeCode: boolean
  /** The route sends images; when it does not, `buildProvider` has the model send them as label lines. */
  readonly images: boolean
  /** The route the model is sent over: a configured endpoint's and a `local` credential's URL are `compat`. */
  readonly route: Route["_tag"]
}

/** The options of a model call, as far as the plugin rewrites them: the prompt. */
export interface PromptOptions {
  readonly prompt: Prompt.RawInput
  readonly toolChoice?: LanguageModel.ToolChoice<string> | undefined
}

/** A call's options with the prompt `f` made of it; every other option is kept. */
export const withPrompt = <O extends PromptOptions>(
  options: O,
  f: (prompt: Prompt.Prompt) => Prompt.Prompt,
): Omit<O, "prompt"> & { readonly prompt: Prompt.Prompt } => ({ ...options, prompt: f(Prompt.make(options.prompt)) })

/** Every call of the model sent with its prompt's file parts as label lines (`promptWithImageLabels`). */
const withImageLabels = (model: LanguageModel.LanguageModel): LanguageModel.LanguageModel => {
  const relabeled = (options: PromptOptions) => withPrompt(options, promptWithImageLabels)
  return {
    ...model,
    generateText: ((options: PromptOptions) => model.generateText(relabeled(options) as never)) as never,
    generateObject: ((options: PromptOptions) => model.generateObject(relabeled(options) as never)) as never,
    streamText: ((options: PromptOptions) => model.streamText(relabeled(options) as never)) as never,
  }
}

/** Other protocols consume the same request bookkeeping before their serializers run. */
const withStrippedVolatileContext = (model: LanguageModel.LanguageModel): LanguageModel.LanguageModel => ({
  ...model,
  generateText: ((options: PromptOptions) => model.generateText(withoutVolatilePrompt(options) as never)) as never,
  generateObject: ((options: PromptOptions) => model.generateObject(withoutVolatilePrompt(options) as never)) as never,
  streamText: ((options: PromptOptions) => model.streamText(withoutVolatilePrompt(options) as never)) as never,
})

/** Preserve typed provider semantics on every model method without altering responses. */
const withProviderFailures = (model: LanguageModel.LanguageModel, protocol: ProviderFailureProtocol): LanguageModel.LanguageModel => {
  const failure = (error: unknown) => AiError.isAiError(error) ? classifyAiError(error, protocol) : error
  return {
    ...model,
    generateText: ((options: PromptOptions) => model.generateText(options as never).pipe(Effect.mapError(failure))) as never,
    generateObject: ((options: PromptOptions) => model.generateObject(options as never).pipe(Effect.mapError(failure))) as never,
    streamText: ((options: PromptOptions) => model.streamText(options as never).pipe(Stream.mapError(failure))) as never,
  }
}

/** The provider's actual alias and invocation kind accompany every physical attempt. */
const withProviderAccounting = (model: LanguageModel.LanguageModel, selection: ModelSelection): LanguageModel.LanguageModel => ({
  ...model,
  generateText: ((options: PromptOptions) => withModelRequestCall("Text", selection, model.generateText(options as never)).pipe(Effect.catch((error) => isTurnError(error) ? Effect.die(error) : Effect.fail(error)))) as never,
  generateObject: ((options: PromptOptions) => withModelRequestCall("Object", selection, model.generateObject(options as never)).pipe(Effect.catch((error) => isTurnError(error) ? Effect.die(error) : Effect.fail(error)))) as never,
  streamText: ((options: PromptOptions) => withModelRequestStream("Stream", selection, model.streamText(options as never))) as never,
})

/**
 * Every request with `betas` added to its `anthropic-beta` header, after
 * the ones the client set itself (`mergeBetas`): a beta is never sent by
 * replacing the header, which would drop the client's own.
 */
const withAnthropicBetas = (betas: ReadonlyArray<string>) => (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  betas.length === 0
    ? client
    : client.pipe(HttpClient.mapRequest((req) => HttpClientRequest.setHeader(req, "anthropic-beta", mergeBetas(Option.fromNullishOr(req.headers["anthropic-beta"]), betas))))

// Anthropic OAuth authenticates as a subscription: Bearer + Claude Code beta
// flags (added to the client's own), never `x-api-key`.
const anthropicOAuthTransform =
  (access: Redacted.Redacted<string>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequest((req) => HttpClientRequest.setHeader(req, "Authorization", `Bearer ${Redacted.value(access)}`)),
      withAnthropicBetas(ANTHROPIC_OAUTH_BETA.split(",")),
    )

const llmThinkingDropped = Metric.counter("llm.thinking.dropped", {
  description: "thinking blocks the provider dropped from a request whose conversation changed before them",
  incremental: true,
})

/** Thinking blocks the provider dropped from a request: on the call's span, counted by reason, and a warning. */
const reportDropped = (label: string) => (reasons: ReadonlyArray<string>): Effect.Effect<void> =>
  reasons.length === 0
    ? Effect.void
    : Effect.gen(function* () {
        yield* Effect.annotateCurrentSpan("llm.thinking.dropped", reasons.length)
        yield* Effect.forEach(reasons, (reason) => Metric.update(Metric.withAttributes(llmThinkingDropped, { "llm.model": label, reason }), 1), { concurrency: 1, discard: true })
        yield* Effect.logWarning(`the provider dropped ${reasons.length} thinking block(s) from the request: the conversation before them changed (${[...new Set(reasons)].join(", ")})`)
      })

/**
 * A body stream that, as it passes through unchanged, reads its first event
 * and reports the thinking blocks the provider dropped (its
 * `message_start`). Nothing is held beyond that first event.
 */
const peekedFirstEvent = <E>(body: Stream.Stream<Uint8Array, E>, report: (reasons: ReadonlyArray<string>) => Effect.Effect<void>) => Effect.gen(function* () {
  const decoder = new TextDecoder()
  // The text before the first event's end while it has not come whole; none once it was read.
  const pending = yield* Ref.make(Option.some(""))
  const read = (bytes: Uint8Array) => Ref.modify(pending, (seen): [Option.Option<string>, Option.Option<string>] => Option.match(seen, {
    onNone: () => [Option.none(), Option.none()],
    onSome: (before) => {
      const text = before + decoder.decode(bytes, { stream: true })
      const first = firstEventData(text)
      return Option.isSome(first) ? [first, Option.none()] : [Option.none(), Option.some(text)]
    },
  })).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: (data) => report(droppedInMessageStart(data)) })))
  return yield* body.pipe(Stream.tap(read), Stream.toReadableStreamEffect())
})

/**
 * The client with each response's `input_transformations` read and the
 * dropped thinking blocks reported (`reportDropped`): a settled body read
 * whole and handed on as it was, a stream peeked at its first event as it
 * passes. A body that does not say what it changed reports nothing, and
 * the report never fails a call.
 */
const reportingDroppedThinking = (label: string) => (client: HttpClient.HttpClient): HttpClient.HttpClient =>
  HttpClient.transformResponse(client, Effect.flatMap((response) => {
    const rebuilt = (body: BodyInit) => retainModelAttempt(response, HttpClientResponse.fromWeb(response.request, new Response(body, { status: response.status, headers: new Headers(Object.entries(response.headers)) })))
    return (response.headers["content-type"] ?? "").includes("text/event-stream")
      ? Effect.map(peekedFirstEvent(response.stream, reportDropped(label)), rebuilt)
      : response.text.pipe(Effect.tap((text) => reportDropped(label)(droppedInBody(text))), Effect.map(rebuilt))
  }))

const claudeCodePrompt = Prompt.make([{ role: "system", content: CLAUDE_CODE_SYSTEM }])

/** Prepend the Claude Code system block (subscription-auth requirement). */
export const prependClaudeCode = <O extends PromptOptions>(options: O) =>
  withPrompt(options, (prompt) => Prompt.concat(claudeCodePrompt, prompt))

/** Remove recognized request bookkeeping without changing provider options. */
const withoutVolatilePrompt = <O extends PromptOptions>(options: O) => withPrompt(options, (prompt) => Prompt.fromMessages(prompt.content.map((message) => {
  const cleaned = stripVolatileContext(message.options)
  return cleaned === message.options ? message : Prompt.makeMessage(message.role, { ...message, options: cleaned } as never)
})))

/** Mint call-local candidates before the SDK places them on actual cacheable blocks. */
const prepareCachePrompt = (options: PromptOptions, policy: PromptCacheSettings, capability: boolean) => {
  const prompt = Prompt.make(options.prompt)
  const firstVolatile = prompt.content.findIndex((message) => isVolatileContext(message.options))
  const cut = firstVolatile < 0 ? prompt.content.length : firstVolatile
  const relocatedVolatile = prompt.content.slice(cut).some((message) => message.role === "system")
  const ttl = capability && !relocatedVolatile ? Match.valueTags(policy, {
    Auto: (value) => Option.some(value.ttl), TopLevel: () => Option.none(), Off: () => Option.none(),
  }) : Option.none()
  const stable = prompt.content.slice(0, cut)
  const lastSystem = stable.findLastIndex((message) => message.role === "system")
  const recent = stable.flatMap((message, index) => message.role === "system" ? [] : [index]).slice(-2).toReversed()
  const targets = [...recent.map((index, priority) => ({ index, priority })), ...(lastSystem < 0 ? [] : [{ index: lastSystem, priority: 2 }])]
  const prepared = prompt.content.reduce<{ readonly messages: ReadonlyArray<Prompt.Message>; readonly candidates: PromptCacheFrame["candidates"] }>((state, message, index) => {
    const target = targets.find((value) => value.index === index)
    const own = message.options["anthropic"]
    const cache = Predicate.hasProperty(own, "cacheControl") ? own.cacheControl : undefined
    const candidate = target !== undefined && cache === undefined && (own == null || Predicate.isObject(own))
      ? Option.map(ttl, (value): PromptCacheFrame["candidates"][number] => ({ priority: target.priority, control: value === "5m" ? { type: "ephemeral" } : { type: "ephemeral", ttl: value } })) : Option.none()
    const cleaned = stripVolatileContext(message.options)
    const next = Option.match(candidate, {
      onNone: () => cleaned === message.options ? message : Prompt.makeMessage(message.role, { ...message, options: cleaned } as never),
      onSome: ({ control }) => Prompt.makeMessage(message.role, { ...message, options: { ...cleaned, anthropic: { ...(Predicate.isObject(own) ? own : {}), cacheControl: control } } } as never),
    })
    return { messages: [...state.messages, next], candidates: [...state.candidates, ...Option.toArray(candidate)] }
  }, { messages: [], candidates: [] })
  return { options: { ...options, prompt: Prompt.fromMessages(prepared.messages) }, frame: { candidates: prepared.candidates, policy, capability } satisfies PromptCacheFrame }
}

type CachePath = ReadonlyArray<string | number>
interface PreparedCacheSlot {
  readonly path: CachePath
  readonly control: unknown
  readonly cacheable: boolean
}
const cacheField = (value: unknown, key: string): unknown => Predicate.hasProperty(value, key) ? value[key] : undefined
const cachePathKey = (path: CachePath): string => path.join("/")
const cacheableBlock = (block: unknown): boolean => {
  const type = cacheField(block, "type")
  return type !== "thinking" && type !== "redacted_thinking" && (type !== "text" || (typeof cacheField(block, "text") === "string" && cacheField(block, "text") !== ""))
}
/** Nested content ends before its enclosing tool-result block ends. Business JSON is never walked. */
const cacheSlotsInBlocks = (blocks: unknown, path: CachePath): ReadonlyArray<PreparedCacheSlot> => Array.isArray(blocks) ? blocks.flatMap((block: unknown, index) => {
  const at = [...path, index]
  return [
    ...(cacheField(block, "type") === "tool_result" ? cacheSlotsInBlocks(cacheField(block, "content"), [...at, "content"]) : []),
    { path: at, control: cacheField(block, "cache_control"), cacheable: cacheableBlock(block) },
  ]
}) : []
const preparedCacheSlots = (payload: unknown): ReadonlyArray<PreparedCacheSlot> => [
  ...cacheSlotsInBlocks(cacheField(payload, "tools"), ["tools"]),
  ...cacheSlotsInBlocks(cacheField(payload, "system"), ["system"]),
  ...Option.match(Option.filter(Option.fromNullishOr(cacheField(payload, "messages")), Array.isArray), {
    onNone: () => [], onSome: (messages) => messages.flatMap((message: unknown, index) => cacheSlotsInBlocks(cacheField(message, "content"), ["messages", index, "content"])),
  }),
]
const cacheFailure = (error: PromptCacheError): AiError.AiError => AiError.make({
  module: "Models", method: "promptCache", reason: new AiError.InvalidRequestError({ description: error.message }),
})
const withoutCacheField = <A extends object>(value: A): Omit<A, "cache_control"> => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control")) as Omit<A, "cache_control">

/** Copy only protocol branches; never interpret a tool's input or schema as cache metadata. */
const rewriteCachePayload = <A extends object>(payload: A, patches: ReadonlyMap<string, Option.Option<PromptCacheControl>>, topLevel: Option.Option<PromptCacheControl>, capability: boolean): A => {
  const blocks = (value: unknown, path: CachePath): unknown => Array.isArray(value) ? value.map((block: unknown, index) => {
    if (!Predicate.isObject(block)) return block
    const at = [...path, index]
    const nested = cacheField(block, "type") === "tool_result" && Array.isArray(cacheField(block, "content"))
      ? { ...block, content: blocks(cacheField(block, "content"), [...at, "content"]) } : block
    const patch = patches.get(cachePathKey(at))
    return patch === undefined ? nested : { ...withoutCacheField(nested), ...Option.match(patch, { onNone: () => ({}), onSome: (control) => ({ cache_control: control }) }) }
  }) : value
  const messages = cacheField(payload, "messages")
  return {
    ...withoutCacheField(payload),
    ...(cacheField(payload, "tools") === undefined ? {} : { tools: blocks(cacheField(payload, "tools"), ["tools"]) }),
    ...(cacheField(payload, "system") === undefined ? {} : { system: blocks(cacheField(payload, "system"), ["system"]) }),
    ...(Array.isArray(messages) ? { messages: messages.map((message: unknown, index) => Predicate.isObject(message)
      ? { ...message, content: blocks(cacheField(message, "content"), ["messages", index, "content"]) } : message) } : {}),
    ...Option.match(topLevel, { onNone: () => capability && cacheField(payload, "cache_control") === null ? { cache_control: null } : {}, onSome: (control) => ({ cache_control: control }) }),
  } as A
}

/** Validate the actual SDK payload once for settled, object and streamed calls. */
const finalizeCachePayload = <A extends object>(payload: A): Effect.Effect<A, AiError.AiError> => Effect.gen(function* () {
  const frame = yield* CurrentPromptCacheFrame
  const slots = preparedCacheSlots(payload)
  const origin = (slot: PreparedCacheSlot) => Option.fromNullishOr(frame.candidates.find((candidate) => candidate.control === slot.control))
  const invalid = slots.some((slot) => !slot.cacheable && slot.control != null && Option.isNone(origin(slot)))
  if (invalid) return yield* Effect.fail(cacheFailure(new PromptCacheError({ reason: "Control", message: "a prompt cache control needs a nonempty cacheable content block" })))
  const eligible = slots.filter((slot) => slot.cacheable)
  const plan = yield* Effect.fromResult(planBreakpoints({
    positions: eligible.map((slot): CachePosition => Option.match(origin(slot), {
      onSome: ({ priority }) => ({ _tag: "Auto", priority }),
      onNone: () => slot.control == null ? { _tag: "Unmarked" } : { _tag: "Caller", control: slot.control },
    })),
    policy: frame.policy, capability: frame.capability, callerTopLevel: cacheField(payload, "cache_control"),
  })).pipe(Effect.mapError(cacheFailure))
  const selected = new Set(eligible.flatMap((slot, index) => plan.selectedAuto.includes(index) ? [cachePathKey(slot.path)] : []))
  const patches = new Map(slots.flatMap((slot): ReadonlyArray<readonly [string, Option.Option<PromptCacheControl>]> =>
    Option.isSome(origin(slot)) ? [[cachePathKey(slot.path), selected.has(cachePathKey(slot.path)) ? Option.map(origin(slot), (candidate) => candidate.control) : Option.none()]]
      : !frame.capability ? [[cachePathKey(slot.path), Option.none()]] : [],
  ))
  return rewriteCachePayload(payload, patches, plan.topLevel, frame.capability)
})
const withCachePlanning = (client: AnthropicClient.Service): AnthropicClient.Service => ({
  ...client,
  createMessage: (options) => finalizeCachePayload(options.payload).pipe(Effect.flatMap((payload) => client.createMessage({ ...options, payload }))),
  createMessageStream: (options) => finalizeCachePayload(options.payload).pipe(Effect.flatMap((payload) => client.createMessageStream({ ...options, payload }))),
})

const missingKey = (selection: ModelSelection): AuthError =>
  new AuthError({
    provider: selection.provider,
    message: `no credential for ${selection.provider} — sign in through the AuthStore (storage "local" keeps it in ~/.efferent/runtime/auth.json), or give the models plugin one in credentials or credentialEnv (storage "memory")`,
  })

const notWired = (selection: ModelSelection): AuthError =>
  new AuthError({
    provider: selection.provider,
    message: `provider "${selection.provider}" is not wired (built in: ${BuiltInProvider.literals.join(", ")}; add others as models plugin endpoints)`,
  })

/**
 * A call policy as an OpenAI Responses model's options carry it: its output
 * cap, and (when the route sends one) its effort. The public-API SDK union
 * has no none/xhigh/max — clamp to the nearest supported value (only the
 * subscription dialect is probe-verified for `none`).
 */
const responsesPolicy = (policy: Option.Option<ModelCallPolicy>, sendsEffort: boolean) => Option.match(policy, {
  onNone: () => ({}),
  onSome: (value) => ({
    ...(value.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: value.maxOutputTokens }),
    ...(sendsEffort ? { reasoning: { effort: publicReasoningEffort(value.effort) } } : {}),
  }),
})

/** `<url>/chat/completions` of an OpenAI-compatible base URL. */
export const chatCompletionsUrl = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, "")}/chat/completions`

/**
 * An endpoint's own key: `apiKey`, then the variable `apiKeyEnv` names, read
 * with `Config` from the current ConfigProvider (the process environment
 * unless the host provides another; the environment's reads an empty
 * variable as unset). An empty `apiKey` is still the endpoint's own: it
 * sends no key, and the AuthStore's is not used. Fails with the
 * ConfigError when the provider cannot be read.
 */
export const endpointOwnKey = (endpoint: ModelEndpoint): Effect.Effect<Option.Option<Redacted.Redacted<string>>, Config.ConfigError> =>
  Option.match(Option.fromNullishOr(endpoint.apiKey), {
    onSome: (key) => Effect.succeed(Option.some(Redacted.isRedacted(key) ? key : Redacted.make(key))),
    onNone: () => Option.match(Option.fromNullishOr(endpoint.apiKeyEnv), {
      onNone: () => Effect.succeedNone,
      onSome: (name) => Config.option(Config.Redacted(name)),
    }),
  })

/** An endpoint's key: its own, then the AuthStore's; an empty or missing one sends none. */
const endpointKey = (selection: ModelSelection, endpoint: ModelEndpoint, stored: Redacted.Redacted<string> | undefined): Effect.Effect<Option.Option<string>, AuthError> =>
  endpointOwnKey(endpoint).pipe(
    Effect.mapError((error) => new AuthError({ provider: selection.provider, message: `cannot read the endpoint's key variable: ${error.message}` })),
    Effect.map((own) => own.pipe(
      Option.orElse(() => Option.fromNullishOr(stored)),
      Option.map(Redacted.value),
      Option.filter((value) => value.length > 0),
    )),
  )

/** The transport the plugin was built over, if any: the compat client's fetch goes through it. */
type Transport = Option.Option<Context.Service.Shape<typeof ModelsTransport>>

/**
 * What a provider is built over besides its selection and credential: the
 * configured endpoints, the transport, and the OpenAI subscription's
 * session cache (`None` keeps one per built model). The routed models read
 * them once, where their layer is built, and build every call's provider
 * over them ({@link buildProviderOver}).
 */
export interface ProviderServices {
  readonly endpoints: ModelEndpoints
  readonly modelSettings: ModelSettingsMap
  readonly transport: Transport
  readonly managedTransport: Transport
  readonly sessions: Option.Option<OpenAiCodexSessions>
  /** What a request to a model that binds thinking says about a changed prefix (`thinkingPrefixMismatch`). */
  readonly thinkingPrefixMismatch: ThinkingPrefixMismatch
}

/** The provider services where this runs: `CurrentModelEndpoints`, `CurrentModelSettings`, `ModelsTransport` if provided, `CurrentOpenAiCodexSessions`, `CurrentThinkingPrefixMismatch`. */
export const providerServices: Effect.Effect<ProviderServices> = Effect.all({
  endpoints: Effect.service(CurrentModelEndpoints),
  modelSettings: Effect.service(CurrentModelSettings),
  transport: Effect.serviceOption(ModelsTransport),
  managedTransport: Effect.service(CurrentManagedModelsTransport),
  sessions: Effect.service(CurrentOpenAiCodexSessions),
  thinkingPrefixMismatch: Effect.service(CurrentThinkingPrefixMismatch),
}, { concurrency: 1 })

/** The compat client's `fetchImpl`: the transport's fetch, or (no transport) the global one. */
const compatFetch = (transport: Transport, managed: Transport) =>
  Option.match(Option.filter(transport, (value) => !Option.contains(managed, value)), { onNone: () => ({}), onSome: ({ fetch }) => ({ fetchImpl: fetch }) })

/**
 * How the OpenAI subscription's WebSocket reaches ChatGPT: what the
 * transport says, directly without one. A transport that refuses (a proxy
 * applies that the runtime cannot tunnel a WebSocket through) fails the call
 * with the provider's `AuthError`, which is not retried and does not fall back.
 */
const codexWebSocketProxy = (selection: ModelSelection, transport: Transport): Effect.Effect<Option.Option<WebSocketProxy>, AuthError> =>
  Option.match(Option.flatMap(transport, (found) => Option.fromNullishOr(found.webSocketAgent)), {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (route) => route(new URL(OPENAI_CODEX_API_URL)).pipe(
      Effect.mapError((error) => new AuthError({ provider: selection.provider, message: error.message })),
    ),
  })

/**
 * What a route builds: the model, the settings its descriptor records, as
 * JSON (none for a client that describes itself), and whether its calls take
 * the Claude Code block first.
 */
interface RouteModel {
  readonly svc: LanguageModel.LanguageModel
  readonly settings: Option.Option<Schema.JsonObject>
  readonly prependClaudeCode: boolean
}

/** A model as `buildProvider` describes and wraps it. */
interface Built extends RouteModel {
  readonly images: boolean
  readonly route: Route["_tag"]
}

type Building<A> = Effect.Effect<A, AuthError | ModelSettingsError, HttpClient.HttpClient | Scope.Scope>

const endpointModel = (
  selection: ModelSelection,
  url: string,
  key: Option.Option<string>,
  standardOnly: boolean,
  images: boolean,
  transport: Transport,
  managedTransport: Transport,
): Effect.Effect<Built> =>
  makeCompatLanguageModel({
    moduleName: selection.provider,
    chatUrl: chatCompletionsUrl(url),
    model: selection.modelId,
    standardOnly,
    images,
    ...compatFetch(transport, managedTransport),
    ...Option.match(key, { onNone: () => ({}), onSome: (apiKey) => ({ apiKey }) }),
  }).pipe(Effect.map((svc) => ({ svc, settings: Option.none(), prependClaudeCode: false, images, route: "compat" as const })))

/** A configured endpoint first, then a `local` credential's URL, then the built-in providers. */
const buildProviderService = (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
  services: ProviderServices,
): Building<Built> => {
  const endpoint = Object.hasOwn(services.endpoints, selection.provider) ? Option.fromNullishOr(services.endpoints[selection.provider]) : Option.none<ModelEndpoint>()
  if (Option.isSome(endpoint)) {
    const configured = endpoint.value
    return Effect.flatMap(endpointKey(selection, configured, key), (own) => {
      if (configured.api === "anthropic-messages") {
        const model = anthropicProfileOf(selection.modelId)
        return anthropicModel({ selection, model, modelSettings: services.modelSettings, thinkingPrefixMismatch: services.thinkingPrefixMismatch }, {
          _tag: "Api", key: Option.map(own, Redacted.make), endpoint: Option.some(configured),
        }).pipe(Effect.map((built) => ({ ...built, images: configured.images ?? model.images, route: "anthropic" as const })))
      }
      return otherRouteSettings(selection, services.modelSettings).pipe(Effect.andThen(
        endpointModel(selection, configured.url, own, configured.standardOnly ?? true, configured.images ?? false, services.transport, services.managedTransport),
      ))
    })
  }
  if (credential?.type === "local" && credential.baseUrl !== undefined) {
    return otherRouteSettings(selection, services.modelSettings).pipe(Effect.andThen(endpointModel(selection, credential.baseUrl, Option.none(), true, false, services.transport, services.managedTransport)))
  }
  return buildBuiltInProvider(selection, credential, key, services)
}

/** What a route builder is given: the selection, its model's profile, the credential and its key, the transport, the subscription's sessions. */
interface RouteCall {
  readonly selection: ModelSelection
  readonly model: ModelProfile
  readonly modelSettings: ModelSettingsMap
  readonly credential: Credential | undefined
  readonly key: Redacted.Redacted<string>
  readonly transport: Transport
  readonly managedTransport: Transport
  readonly sessions: Option.Option<OpenAiCodexSessions>
  readonly thinkingPrefixMismatch: ThinkingPrefixMismatch
}

type MessagesEndpoint = Extract<ModelEndpoint, { readonly api: "anthropic-messages" }>
type AnthropicAuthentication =
  | { readonly _tag: "Api"; readonly key: Option.Option<Redacted.Redacted<string>>; readonly endpoint: Option.Option<MessagesEndpoint> }
  | { readonly _tag: "Subscription"; readonly access: Redacted.Redacted<string> }

/** Accept a root, a proxy prefix or a base ending in /v1, without doubling the Messages path. */
export const anthropicBaseUrl = (base: string): string => base.replace(/\/+$/, "").replace(/\/v1$/, "")

/** A model configuration failure is not an authentication failure or a retryable provider outage. */
export const modelSettingsFailure = (error: ModelSettingsError): AiError.AiError => AiError.make({
  module: "Models", method: "settings", reason: new AiError.InvalidRequestError({ description: error.message }),
})

const otherRouteSettings = (selection: ModelSelection, settings: ModelSettingsMap) =>
  Object.hasOwn(settings, formatModelSelection(selection)) && Object.keys(settings[formatModelSelection(selection)] ?? {}).length > 0
    ? Effect.fail(new ModelSettingsError({ reason: "Selection", message: "per-model settings require an Anthropic Messages route for this selection" })) : Effect.void

const forcedTool = (choice: PromptOptions["toolChoice"]): boolean => choice === "required" ||
  (Predicate.isObject(choice) && ("tool" in choice || choice.mode === "required"))

/**
 * Boolean projection of @effect/ai-anthropic 4.0.7's private
 * getModelCapabilities: its earlier 4.5/Opus 4.1 matches win over legacy
 * substrings, including in configured deployment IDs. This mirrors SDK
 * request shaping, not a claim about a model's API capabilities.
 */
const pinnedAnthropicNativeJson = (model: Schema.Json | undefined): boolean =>
  typeof model !== "string" ||
  ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5", "claude-opus-4-1"].some((id) => model.includes(id)) ||
  !["claude-sonnet-4-0", "claude-sonnet-4-20250514", "claude-opus-4-0", "claude-opus-4-20250514", "claude-3-"].some((id) => model.includes(id))

/** Validate request-dependent controls before the SDK can send a request. Owned model fields keep their resolved precedence. */
const withAnthropicSettings = (model: LanguageModel.LanguageModel, resolved: ResolvedAnthropicSettings, wire: Schema.JsonObject, binding: boolean, capability: boolean): LanguageModel.LanguageModel => {
  const prepare = (options: PromptOptions, object = false) => Effect.flatMap(Effect.serviceOption(AnthropicLanguageModel.Config), (ambient) => {
    // Absence is owned too: unsupported effort and unconfigured unknown
    // thinking must not reappear through the SDK's later context merge.
    const { thinking: _thinking, output_config: _outputConfig, ...unowned } = Option.getOrElse(ambient, (): typeof AnthropicLanguageModel.Config.Service => ({}))
    const nativeJson = unowned.structuredOutputs ?? pinnedAnthropicNativeJson(wire["model"])
    return Effect.fromResult(validateAnthropicRequest(resolved, { forcedTool: forcedTool(options.toolChoice) || (object && !nativeJson), binding })).pipe(
      Effect.mapError(modelSettingsFailure),
      Effect.map(() => ({ config: { ...unowned, ...wire }, ...prepareCachePrompt(options, resolved.promptCache, capability) })),
    )
  })
  return {
    ...model,
    generateText: ((options: PromptOptions) => prepare(options).pipe(Effect.flatMap(({ config, options: shaped, frame }) => model.generateText(shaped as never).pipe(Effect.provideService(AnthropicLanguageModel.Config, config as never), Effect.provideService(CurrentPromptCacheFrame, frame))))) as never,
    generateObject: ((options: PromptOptions) => prepare(options, true).pipe(Effect.flatMap(({ config, options: shaped, frame }) => model.generateObject(shaped as never).pipe(Effect.provideService(AnthropicLanguageModel.Config, config as never), Effect.provideService(CurrentPromptCacheFrame, frame))))) as never,
    streamText: ((options: PromptOptions) => Stream.unwrap(prepare(options).pipe(Effect.map(({ config, options: shaped, frame }) => model.streamText(shaped as never).pipe(Stream.provideService(AnthropicLanguageModel.Config, config as never), Stream.provideService(CurrentPromptCacheFrame, frame)))))) as never,
  }
}

/** Public Messages controls shared by provider construction and durable routing descriptions; no credentials or client IO. */
export const resolveMessagesConfiguration = (
  selection: ModelSelection,
  modelSettings: ModelSettingsMap,
  policy: Option.Option<ModelCallPolicy>,
  thinkingPrefixMismatch: ThinkingPrefixMismatch,
  endpoint: Option.Option<MessagesEndpoint>,
) => Result.flatMap(resolveAnthropicSettings(formatModelSelection(selection), modelSettings, policy), (resolved) => {
  const binding = bindingFor(anthropicProfileOf(selection.modelId).bindsThinking && Option.exists(resolved.thinking, (value) => value._tag === "Adaptive"), thinkingPrefixMismatch)
  return Result.map(validateAnthropicRequest(resolved, { forcedTool: false, binding: Option.isSome(binding) }), () => {
    const wire: Schema.JsonObject = {
      model: selection.modelId,
      max_tokens: resolved.maxOutputTokens,
      ...Option.match(resolved.effort, { onNone: () => ({}), onSome: (effort) => ({ output_config: { effort } }) }),
      ...Option.match(resolved.thinking, { onNone: () => ({}), onSome: (thinking) => ({ thinking: ModelThinking.match(thinking, {
        Adaptive: (value) => ({ type: "adaptive", display: value.display ?? "summarized", ...Option.match(binding, { onNone: () => ({}), onSome: (behavior) => ({ block_binding: { prefix_mismatch_behavior: behavior } }) }) }),
        Budget: (value) => ({ type: "enabled", budget_tokens: value.budgetTokens, display: value.display ?? "summarized" }),
        BetweenTools: () => ({ type: "between_tools" }),
        Off: () => ({ type: "disabled" }),
      }) }) }),
    }
    const settings: Schema.JsonObject = { ...wire, promptCache: resolved.promptCache, cacheControl: Option.match(endpoint, { onNone: () => true, onSome: (value) => value.cacheControl ?? true }),
      ...Option.match(endpoint, { onNone: () => ({}), onSome: (value) => ({ endpoint: { api: value.api, url: anthropicBaseUrl(value.url), auth: value.auth ?? "x-api-key", apiVersion: value.apiVersion ?? "2023-06-01", betas: value.betas ?? [], cacheControl: value.cacheControl ?? true } }) }),
      ...Option.match(binding, { onNone: () => ({}), onSome: (behavior) => ({ thinkingPrefixMismatch: behavior }) }),
    }
    return { resolved, binding, wire, settings }
  })
})

/** The SDK accepts a narrower reader/client error type but leaves typed AiErrors untouched.
 * Keep the response-reader and client erasure at this existing SDK boundary. */
const requestClient = (client: HttpClient.HttpClient, protocol: ProviderFailureProtocol): HttpClient.HttpClient =>
  resilientHttpClient(client, { protocol, adaptResponse: (response) => response as never }) as never

/** One Messages builder for built-in API keys, explicit gateway auth, and subscription OAuth. */
const anthropicModel = (
  { selection, modelSettings, thinkingPrefixMismatch }: Pick<RouteCall, "selection" | "model" | "modelSettings" | "thinkingPrefixMismatch">,
  authentication: AnthropicAuthentication,
): Building<RouteModel> => Effect.gen(function* () {
  const endpoint = Match.valueTags(authentication, { Api: (value) => value.endpoint, Subscription: () => Option.none<MessagesEndpoint>() })
  const { resolved, binding, wire, settings } = yield* Effect.fromResult(resolveMessagesConfiguration(selection, modelSettings, yield* CurrentModelCallPolicy, thinkingPrefixMismatch, endpoint))
  const bound = (client: HttpClient.HttpClient) => Option.match(binding, {
    onNone: () => client,
    onSome: () => client.pipe(withAnthropicBetas([THINKING_BINDING_BETA]), reportingDroppedThinking(formatModelSelection(selection))),
  })
  const options = Match.valueTags(authentication, {
    Subscription: ({ access }): AnthropicClient.Options => ({ transformClient: (client) => bound(requestClient(anthropicOAuthTransform(access)(client), "anthropic")) }),
    Api: ({ key, endpoint }): AnthropicClient.Options => ({
      ...Option.match(key, { onNone: () => ({}), onSome: (apiKey) => Option.exists(endpoint, (value) => value.auth === "bearer") ? {} : { apiKey } }),
      ...Option.match(endpoint, { onNone: () => ({}), onSome: (value) => ({ apiUrl: anthropicBaseUrl(value.url), ...(value.apiVersion === undefined ? {} : { apiVersion: value.apiVersion }) }) }),
      transformClient: (client) => {
        const authenticated = Option.match(Option.filter(endpoint, (value) => value.auth === "bearer"), {
          onNone: () => client,
          onSome: () => Option.match(key, { onNone: () => client, onSome: (apiKey) => client.pipe(HttpClient.mapRequest((request) => HttpClientRequest.setHeader(request, "Authorization", `Bearer ${Redacted.value(apiKey)}`))) }),
        })
        return bound(requestClient(authenticated.pipe(withAnthropicBetas(Option.match(endpoint, { onNone: () => [], onSome: (value) => value.betas ?? [] }))), "anthropic"))
      },
    }),
  })
  const client = withAnthropicFailures(withCachePlanning(yield* AnthropicClient.make(options)))
  const service = yield* AnthropicLanguageModel.make({ model: selection.modelId, config: wire as never }).pipe(Effect.provideService(AnthropicClient.AnthropicClient, client))
  const oauth = authentication._tag === "Subscription"
  return {
    svc: withAnthropicSettings(service, resolved, wire, Option.isSome(binding), Option.match(endpoint, { onNone: () => true, onSome: (value) => value.cacheControl ?? true })),
    settings: Option.some({ ...wire, systemPrelude: oauth ? CLAUDE_CODE_SYSTEM : null, ...settings }),
    prependClaudeCode: oauth,
  }
})

/**
 * The OpenAI Responses API (`openai`, OpenCode's GPT models), built with the
 * options its descriptor records: the route's JSON-schema mode, the call's
 * cache key, and its policy. The effort goes to every model of an `always`
 * route, and on a `listed` one only to a model whose profile lists efforts,
 * clamped to the public vocabulary; a model that takes none (a
 * non-reasoning one) would refuse it.
 */
const responsesModel = (route: ResponsesRoute, { selection, model, key }: RouteCall): Building<RouteModel> =>
  Effect.all({ cacheKey: Effect.service(CurrentPromptCacheKey), policy: Effect.service(CurrentModelCallPolicy) }, { concurrency: 1 }).pipe(
    Effect.flatMap(({ cacheKey, policy }) => {
      // The per-conversation cache lane, same as the compat path — one
      // shared constant lane cross-evicts between conversations
      // (construction happens per call, inside the run's fiber, so the
      // reference and the call policy are set here). The descriptor records
      // these exact values, captured at construction.
      const config = {
        ...Option.match(route.strictJsonSchema, { onNone: () => ({}), onSome: (strictJsonSchema) => ({ strictJsonSchema }) }),
        prompt_cache_key: Option.getOrElse(cacheKey, () => "efferent"),
        ...responsesPolicy(policy, route.effort === "always" || model.efforts.length > 0),
      }
      return OpenAiClient.make({ apiKey: key, transformClient: (client) => requestClient(client, "openai"), ...Option.match(route.apiUrl, { onNone: () => ({}), onSome: (apiUrl) => ({ apiUrl }) }) }).pipe(
        Effect.flatMap((client) =>
          OpenAiLanguageModel.make({ model: selection.modelId, config }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, withOpenAiFailures(client))),
        ),
        Effect.map((svc) => ({ svc, settings: Option.some(config), prependClaudeCode: false })),
      )
    }),
  )

/** The OpenAI subscription's Codex dialect, over its OAuth token and the ChatGPT account it names, keeping its session ids in `sessions`. */
const codexModel = ({ selection, credential, key, transport, sessions }: RouteCall): Building<RouteModel> => {
  if (credential?.type !== "oauth") return Effect.fail(missingKey(selection))
  const accountId = Option.orElse(Option.fromNullishOr(credential.accountId), () => openAiCodexAccountId(Redacted.value(key)))
  if (Option.isNone(accountId)) {
    return Effect.fail(new AuthError({ provider: selection.provider, message: "the OpenAI subscription token has no ChatGPT account id — sign in to the subscription again and store the new token" }))
  }
  return codexWebSocketProxy(selection, transport).pipe(
    Effect.flatMap((webSocketProxy) => makeOpenAiCodexLanguageModel({ model: selection.modelId, accessToken: key, accountId: accountId.value, webSocketProxy }).pipe(
      Effect.provideService(CurrentOpenAiCodexSessions, sessions),
    )),
    Effect.map((svc) => ({ svc, settings: Option.none(), prependClaudeCode: false })),
  )
}

/** An OpenAI-compatible gateway's chat completions (OpenCode's other models, Gemini). */
const chatModel = (route: ChatRoute, { selection, model, key, transport, managedTransport }: RouteCall): Building<RouteModel> =>
  makeCompatLanguageModel({
    moduleName: route.moduleName,
    chatUrl: route.chatUrl,
    apiKey: Redacted.value(key),
    model: selection.modelId,
    standardOnly: route.standardOnly,
    usage: route.usage,
    images: model.images,
    ...compatFetch(transport, managedTransport),
  }).pipe(Effect.map((svc) => ({ svc, settings: Option.none(), prependClaudeCode: false })))

/** A built-in provider's model, by the route its profile names; every route needs a key. */
const buildBuiltInProvider = (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
  { transport, managedTransport, sessions, thinkingPrefixMismatch, modelSettings }: ProviderServices,
): Building<Built> =>
  Option.match(profileOf(selection.provider), {
    onNone: () => Effect.fail(notWired(selection)),
    onSome: (profile) => Option.match(Option.fromNullishOr(key), {
      onNone: () => Effect.fail(missingKey(selection)),
      onSome: (found) => {
        const call: RouteCall = { selection, model: profile.modelOf(selection.modelId), credential, key: found, transport, managedTransport, sessions, thinkingPrefixMismatch, modelSettings }
        const route = profile.routeOf(selection.modelId)
        const built: Building<RouteModel> = Match.valueTags(route, {
          anthropic: () => anthropicModel(call, credential?.type === "oauth" ? { _tag: "Subscription", access: found } : { _tag: "Api", key: Option.some(found), endpoint: Option.none() }),
          "openai-responses": (responses) => responsesModel(responses, call),
          "openai-codex": () => codexModel(call),
          compat: (chat) => chatModel(chat, call),
        })
        return Effect.map(route._tag === "anthropic" ? built : otherRouteSettings(selection, modelSettings).pipe(Effect.andThen(built)), (routed) => ({ ...routed, images: call.model.images, route: route._tag }))
      },
    }),
  })

/** The model's descriptor: the settings its route built it with, or the one a client that describes itself states, under the selection's provider. */
const descriptorOf = (selection: ModelSelection, built: Built) =>
  Option.match(built.settings, {
    onSome: (settings) => Effect.succeed({ provider: selection.provider, model: selection.modelId, settings }),
    onNone: () => modelRequestDescriptorOf(built.svc).pipe(Effect.map(Option.match({
      // Every client built here describes itself; one that did not would record no settings.
      onNone: () => ({ provider: selection.provider, model: selection.modelId, settings: {} }),
      onSome: (value) => ({ ...value, provider: selection.provider }),
    }))),
  })

/**
 * {@link buildProvider} over the given provider services, not those where
 * it runs: a routed model builds each call's provider over the services its
 * layer was built with.
 */
export const buildProviderOver = (services: ProviderServices) => (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
): Effect.Effect<BuiltProvider, AuthError | ModelSettingsError, HttpClient.HttpClient | Scope.Scope> => buildProviderService(selection, credential, key, services).pipe(
  Effect.map((built) => {
    const classified = withProviderAccounting(withProviderFailures(built.svc, providerFailureProtocol(built.route)), selection)
    const labeled = built.images ? classified : withImageLabels(classified)
    return {
      svc: describeModel(built.route === "anthropic" ? labeled : withStrippedVolatileContext(labeled), descriptorOf(selection, built)),
      prependClaudeCode: built.prependClaudeCode,
      images: built.images,
      route: built.route,
    }
  }),
)

/**
 * Preserve adapter descriptors and describe the public configuration of
 * SDK-backed models. On a route that reads no images (the model's profile,
 * a configured endpoint's `images`), every request is sent with its images
 * as label lines (`promptWithImageLabels`) instead of a provider error.
 * Built over the provider services where it runs (`providerServices`).
 */
export const buildProvider = (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
): Effect.Effect<BuiltProvider, AuthError | ModelSettingsError, HttpClient.HttpClient | Scope.Scope> =>
  Effect.flatMap(providerServices, (services) => buildProviderOver(services)(selection, credential, key))
