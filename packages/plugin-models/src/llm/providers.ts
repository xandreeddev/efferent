import { LanguageModel, Prompt } from "effect/ai"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Config, Effect, Option, Redacted } from "effect"
import type { Context, Scope } from "effect"
import { AuthError, CurrentModelCallPolicy, CurrentPromptCacheKey, describeModel, formatModelSelection, modelRequestDescriptorOf } from "@xandreed/core"
import type { Credential, ModelCallPolicy, ModelSelection } from "@xandreed/core"
import { ANTHROPIC_OAUTH_BETA, CLAUDE_CODE_SYSTEM } from "../auth/anthropicOAuth.js"
import { makeCompatLanguageModel, promptWithImageLabels } from "./compat.js"
import { imageInputFor, publicReasoningEffort, reasoningEffortsFor, usesOpenCodeResponses } from "./modelCatalog.js"
import { makeOpenAiCodexLanguageModel, OPENAI_CODEX_API_URL } from "./openAiCodex.js"
import { openAiCodexAccountId } from "../auth/openAiCodexOAuth.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelEndpoint } from "../ports/model-endpoints.port.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
import type { WebSocketProxy } from "../ports/models-transport.port.js"

/**
 * Per-provider `LanguageModel` construction. Built PER REQUEST from a
 * freshly-resolved key (never captured at layer build), so a credential or
 * model switch applies on the next call.
 *
 * v1 providers: opencode (OpenAI-compatible gateway — the default), google
 * (Gemini's OpenAI-compatible endpoint), anthropic (api key or subscription
 * OAuth), openai (api key), openai-codex (subscription OAuth). A configured
 * endpoint, or a `local` credential with a `baseUrl`, sends its provider's
 * models to that OpenAI-compatible URL, with or without a key.
 */

export const OPENCODE_CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions"
/** OpenCode serves GPT models through the OpenAI Responses protocol. */
export const OPENCODE_RESPONSES_API_URL = "https://opencode.ai/zen/v1"

/** Gemini through its OpenAI-compatible chat completions (Bearer API key). */
export const GOOGLE_CHAT_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"

export { usesOpenCodeResponses }

export interface BuiltProvider {
  readonly svc: LanguageModel.LanguageModel
  /** Anthropic subscription auth requires the Claude Code system block first. */
  readonly prependClaudeCode: boolean
  /** The route sends images; when it does not, `buildProvider` has the model send them as label lines. */
  readonly images: boolean
}

/** Every call of the model sent with its prompt's file parts as label lines (`promptWithImageLabels`). */
const withImageLabels = (model: LanguageModel.LanguageModel): LanguageModel.LanguageModel => {
  const relabeled = (options: unknown): unknown => ({
    ...(options as Record<string, unknown>),
    prompt: promptWithImageLabels(Prompt.make((options as { readonly prompt: Prompt.RawInput }).prompt)),
  })
  return {
    ...model,
    generateText: ((options: unknown) => model.generateText(relabeled(options) as never)) as never,
    generateObject: ((options: unknown) => model.generateObject(relabeled(options) as never)) as never,
    streamText: ((options: unknown) => model.streamText(relabeled(options) as never)) as never,
  }
}

// Anthropic OAuth authenticates as a subscription: Bearer + Claude Code beta
// flags, never `x-api-key`.
const anthropicOAuthTransform =
  (access: Redacted.Redacted<string>) =>
  (client: HttpClient.HttpClient): HttpClient.HttpClient =>
    client.pipe(
      HttpClient.mapRequest((req) =>
        req.pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bearer ${Redacted.value(access)}`,
            "anthropic-beta": ANTHROPIC_OAUTH_BETA,
          }),
        ),
      ),
    )

const claudeCodePrompt = Prompt.make([{ role: "system", content: CLAUDE_CODE_SYSTEM }])

/** Prepend the Claude Code system block (subscription-auth requirement). */
export const prependClaudeCode = (options: unknown): unknown => ({
  ...(options as Record<string, unknown>),
  prompt: Prompt.concat(
    claudeCodePrompt,
    Prompt.make((options as { prompt: Prompt.RawInput }).prompt),
  ),
})

/**
 * Anthropic prompt caching is OPT-IN per request: stamp ephemeral
 * `cache_control` breakpoints on the last system message + the last two
 * non-system messages. Marker placement is not part of Anthropic's content
 * hash, so the markers moving forward each turn never invalidates earlier
 * prefixes. Messages already carrying an explicit `cacheControl` are left
 * alone.
 */
export const withAnthropicCacheBreakpoints = (options: unknown): unknown => {
  const prompt = Prompt.make((options as { prompt: Prompt.RawInput }).prompt)
  const messages = prompt.content
  if (messages.length === 0) return options

  const lastSystem = messages.reduce(
    (acc: number, m, i) => (m.role === "system" ? i : acc),
    -1,
  )
  const nonSystem = messages.flatMap((m, i) => (m.role === "system" ? [] : [i]))
  const stampIdx = new Set([
    ...(lastSystem >= 0 ? [lastSystem] : []),
    ...nonSystem.slice(-2),
  ])

  const stamped = messages.map((msg, i) => {
    if (!stampIdx.has(i)) return msg
    const anthropic = (msg.options["anthropic"] ?? {}) as Record<string, unknown>
    if (anthropic["cacheControl"] !== undefined) return msg
    return Prompt.makeMessage(msg.role, {
      ...msg,
      options: {
        ...msg.options,
        anthropic: { ...anthropic, cacheControl: { type: "ephemeral" } },
      },
    } as never)
  })
  return {
    ...(options as Record<string, unknown>),
    prompt: Prompt.fromMessages(stamped),
  }
}

const missingKey = (selection: ModelSelection): AuthError =>
  new AuthError({
    provider: selection.provider,
    message: `no credential for ${selection.provider} — sign in through the AuthStore (storage "local" keeps it in ~/.efferent/runtime/auth.json), or give the models plugin one in credentials or credentialEnv (storage "memory")`,
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

/** The OpenCode Responses options: what the model is built with, and what its descriptor records. */
const openCodeResponsesConfig = (cacheKey: Option.Option<string>, policy: Option.Option<ModelCallPolicy>) => ({
  // UI tools contain genuinely optional fields. OpenAI strict
  // schemas require every property, so use normal function
  // calling and let Effect decode the domain schema.
  strictJsonSchema: false,
  prompt_cache_key: Option.getOrElse(cacheKey, () => "efferent"),
  ...responsesPolicy(policy, true),
})

/**
 * The OpenAI API options: what the model is built with, and what its
 * descriptor records. The effort is sent to a model that takes one
 * (`reasoningEffortsFor`), clamped to the public vocabulary; a model that
 * takes none (a non-reasoning one) is sent none, which it would refuse.
 */
const openAiConfig = (selection: ModelSelection, cacheKey: Option.Option<string>, policy: Option.Option<ModelCallPolicy>) => ({
  prompt_cache_key: Option.getOrElse(cacheKey, () => "efferent"),
  ...responsesPolicy(policy, reasoningEffortsFor(formatModelSelection(selection)).length > 0),
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

/** The compat client's `fetchImpl`: the transport's fetch, or (no transport) the global one. */
const compatFetch = (transport: Transport) =>
  Option.match(transport, { onNone: () => ({}), onSome: ({ fetch }) => ({ fetchImpl: fetch }) })

/**
 * How the OpenAI subscription's WebSocket reaches ChatGPT: what the
 * transport says, directly without one. A transport that refuses (a proxy
 * applies that the runtime cannot tunnel a WebSocket through) fails the call
 * with the provider's `AuthError`, which is not retried and does not fall back.
 */
const codexWebSocketProxy = (transport: Transport): Effect.Effect<Option.Option<WebSocketProxy>, AuthError> =>
  Option.match(Option.flatMap(transport, (found) => Option.fromNullishOr(found.webSocketAgent)), {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (route) => route(new URL(OPENAI_CODEX_API_URL)).pipe(
      Effect.mapError((error) => new AuthError({ provider: "openai-codex", message: error.message })),
    ),
  })

const endpointModel = (
  selection: ModelSelection,
  url: string,
  key: Option.Option<string>,
  standardOnly: boolean,
  images: boolean,
  transport: Transport,
): Effect.Effect<BuiltProvider> =>
  makeCompatLanguageModel({
    moduleName: selection.provider,
    chatUrl: chatCompletionsUrl(url),
    model: selection.modelId,
    standardOnly,
    images,
    ...compatFetch(transport),
    ...Option.match(key, { onNone: () => ({}), onSome: (apiKey) => ({ apiKey }) }),
  }).pipe(Effect.map((svc) => ({ svc, prependClaudeCode: false, images })))

/** A configured endpoint first, then a `local` credential's URL, then the built-in providers. */
const buildProviderService = (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
): Effect.Effect<BuiltProvider, AuthError, HttpClient.HttpClient | Scope.Scope> =>
  Effect.flatMap(Effect.all({ endpoints: Effect.service(CurrentModelEndpoints), transport: Effect.serviceOption(ModelsTransport) }), ({ endpoints, transport }) => {
    const endpoint = Option.fromNullishOr(endpoints[selection.provider])
    if (Option.isSome(endpoint)) {
      const configured = endpoint.value
      return Effect.flatMap(endpointKey(selection, configured, key), (own) =>
        endpointModel(selection, configured.url, own, configured.standardOnly ?? true, configured.images ?? false, transport))
    }
    if (credential?.type === "local" && credential.baseUrl !== undefined) {
      return endpointModel(selection, credential.baseUrl, Option.none(), true, false, transport)
    }
    return buildBuiltInProvider(selection, credential, key, transport)
  })

const buildBuiltInProvider = (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
  transport: Transport,
): Effect.Effect<BuiltProvider, AuthError, HttpClient.HttpClient | Scope.Scope> => {
  const oauth = credential?.type === "oauth"
  const images = imageInputFor(formatModelSelection(selection))
  if (selection.provider === "opencode") {
    if (key === undefined) return Effect.fail(missingKey(selection))
    if (usesOpenCodeResponses(selection.modelId)) {
      return Effect.all({
        cacheKey: Effect.service(CurrentPromptCacheKey),
        policy: Effect.service(CurrentModelCallPolicy),
      }).pipe(
        Effect.flatMap(({ cacheKey, policy }) =>
          OpenAiClient.make({ apiKey: key, apiUrl: OPENCODE_RESPONSES_API_URL }).pipe(
            Effect.flatMap((client) =>
              OpenAiLanguageModel.make({
                model: selection.modelId,
                config: openCodeResponsesConfig(cacheKey, policy),
              }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client)),
            ),
            Effect.map((svc) => ({ svc, prependClaudeCode: false, images })),
          ),
        ),
      )
    }
    return makeCompatLanguageModel({
      moduleName: "OpenCode",
      chatUrl: OPENCODE_CHAT_URL,
      apiKey: Redacted.value(key),
      model: selection.modelId,
      images,
      ...compatFetch(transport),
    }).pipe(Effect.map((svc) => ({ svc, prependClaudeCode: false, images })))
  }
  if (selection.provider === "google") {
    return key === undefined
      ? Effect.fail(missingKey(selection))
      : makeCompatLanguageModel({
          moduleName: "Google",
          chatUrl: GOOGLE_CHAT_URL,
          apiKey: Redacted.value(key),
          model: selection.modelId,
          // As before: no cache key, thinking defaults or call policy for Gemini.
          standardOnly: true,
          // Gemini's completion_tokens may leave its thoughts out: its reasoning reads 0.
          usage: { reasoning: false },
          images,
          ...compatFetch(transport),
        }).pipe(Effect.map((svc) => ({ svc, prependClaudeCode: false, images })))
  }
  if (selection.provider === "anthropic") {
    if (key === undefined) return Effect.fail(missingKey(selection))
    return (
      oauth
        ? AnthropicClient.make({
            apiKey: undefined,
            transformClient: anthropicOAuthTransform(key),
          })
        : AnthropicClient.make({ apiKey: key })
    ).pipe(
      Effect.flatMap((client) =>
        AnthropicLanguageModel.make({ model: selection.modelId }).pipe(
          Effect.provideService(AnthropicClient.AnthropicClient, client),
        ),
      ),
      Effect.map((svc) => ({ svc, prependClaudeCode: oauth, images })),
    )
  }
  if (selection.provider === "openai-codex") {
    if (key === undefined || credential?.type !== "oauth") return Effect.fail(missingKey(selection))
    const accountId = Option.orElse(Option.fromNullishOr(credential.accountId), () => openAiCodexAccountId(Redacted.value(key)))
    if (Option.isNone(accountId)) {
      return Effect.fail(new AuthError({ provider: selection.provider, message: "the OpenAI subscription token has no ChatGPT account id — sign in to the subscription again and store the new token" }))
    }
    return codexWebSocketProxy(transport).pipe(
      Effect.flatMap((webSocketProxy) => makeOpenAiCodexLanguageModel({ model: selection.modelId, accessToken: key, accountId: accountId.value, webSocketProxy })),
      Effect.map((svc) => ({ svc, prependClaudeCode: false, images })),
    )
  }
  if (selection.provider === "openai") {
    return key === undefined
      ? Effect.fail(missingKey(selection))
      : Effect.flatMap(Effect.all({ cacheKey: Effect.service(CurrentPromptCacheKey), policy: Effect.service(CurrentModelCallPolicy) }), ({ cacheKey, policy }) =>
          OpenAiClient.make({ apiKey: key }).pipe(
            Effect.flatMap((client) =>
              OpenAiLanguageModel.make({
                model: selection.modelId,
                // The per-conversation cache lane, same as the compat path —
                // one shared constant lane cross-evicts between conversations
                // (construction happens per call, inside the run's fiber, so
                // the reference and the call policy are set here).
                config: openAiConfig(selection, cacheKey, policy),
              }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client)),
            ),
            Effect.map((svc) => ({ svc, prependClaudeCode: false, images })),
          ),
        )
  }
  return Effect.fail(
    new AuthError({
      provider: selection.provider,
      message: `provider "${selection.provider}" is not wired (built in: opencode, google, anthropic, openai, openai-codex; add others as models plugin endpoints)`,
    }),
  )
}

/**
 * Preserve adapter descriptors and describe the public configuration of
 * SDK-backed models. On a route that reads no images (`imageInputFor`, a
 * configured endpoint's `images`), every request is sent with its images as
 * label lines (`promptWithImageLabels`) instead of a provider error.
 */
export const buildProvider = (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
): Effect.Effect<BuiltProvider, AuthError, HttpClient.HttpClient | Scope.Scope> => buildProviderService(selection, credential, key).pipe(
  Effect.flatMap((built) => Effect.gen(function* () {
      // SDK model configuration was captured at construction; preserve those exact values.
      const cacheKey = yield* Effect.service(CurrentPromptCacheKey)
      const policy = yield* Effect.service(CurrentModelCallPolicy)
      const responses = selection.provider === "opencode" && usesOpenCodeResponses(selection.modelId)
      const settings = selection.provider === "anthropic"
        ? { systemPrelude: built.prependClaudeCode ? CLAUDE_CODE_SYSTEM : null }
        : responses
          ? openCodeResponsesConfig(cacheKey, policy)
          : selection.provider === "openai"
            ? openAiConfig(selection, cacheKey, policy)
            : { prompt_cache_key: Option.getOrElse(cacheKey, () => "efferent") }
      const descriptor = { provider: selection.provider, model: selection.modelId, settings }
      return {
        ...built,
        svc: describeModel(built.images ? built.svc : withImageLabels(built.svc), modelRequestDescriptorOf(built.svc).pipe(Effect.map((existing) =>
          Option.match(existing, { onNone: () => descriptor, onSome: (value) => ({ ...value, provider: selection.provider }) }),
        ))),
      }
  })),
)
