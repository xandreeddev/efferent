import { LanguageModel, Prompt } from "effect/ai"
import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Config, Effect, Match, Option, Predicate, Redacted } from "effect"
import type { Context, Schema, Scope } from "effect"
import { CurrentModelCallPolicy, CurrentPromptCacheKey, describeModel, modelRequestDescriptorOf } from "@xandreed/core"
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
import { profileOf } from "./provider-profile.entity.functions.js"
import { openAiCodexAccountId } from "../auth/openAiCodexOAuth.js"
import { CurrentModelEndpoints } from "../ports/model-endpoints.port.js"
import type { ModelEndpoint, ModelEndpoints } from "../ports/model-endpoints.port.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
import type { WebSocketProxy } from "../ports/models-transport.port.js"

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
export const prependClaudeCode = <O extends PromptOptions>(options: O) =>
  withPrompt(options, (prompt) => Prompt.concat(claudeCodePrompt, prompt))

/**
 * Anthropic prompt caching is OPT-IN per request: stamp ephemeral
 * `cache_control` breakpoints on the last system message + the last two
 * non-system messages. Marker placement is not part of Anthropic's content
 * hash, so the markers moving forward each turn never invalidates earlier
 * prefixes. Messages already carrying an explicit `cacheControl` are left
 * alone.
 */
export const withAnthropicCacheBreakpoints = <O extends PromptOptions>(options: O) =>
  withPrompt(options, (prompt) => {
    const messages = prompt.content
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
      const own = msg.options["anthropic"]
      const anthropic: { readonly [key: string]: unknown } = Predicate.isObject(own) ? own : {}
      if (anthropic["cacheControl"] !== undefined) return msg
      return Prompt.makeMessage(msg.role, {
        ...msg,
        options: {
          ...msg.options,
          anthropic: { ...anthropic, cacheControl: { type: "ephemeral" } },
        },
      } as never)
    })
    return Prompt.fromMessages(stamped)
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
  readonly transport: Transport
  readonly sessions: Option.Option<OpenAiCodexSessions>
}

/** The provider services where this runs: `CurrentModelEndpoints`, `ModelsTransport` if provided, `CurrentOpenAiCodexSessions`. */
export const providerServices: Effect.Effect<ProviderServices> = Effect.all({
  endpoints: Effect.service(CurrentModelEndpoints),
  transport: Effect.serviceOption(ModelsTransport),
  sessions: Effect.service(CurrentOpenAiCodexSessions),
}, { concurrency: 1 })

/** The compat client's `fetchImpl`: the transport's fetch, or (no transport) the global one. */
const compatFetch = (transport: Transport) =>
  Option.match(transport, { onNone: () => ({}), onSome: ({ fetch }) => ({ fetchImpl: fetch }) })

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

type Building<A> = Effect.Effect<A, AuthError, HttpClient.HttpClient | Scope.Scope>

const endpointModel = (
  selection: ModelSelection,
  url: string,
  key: Option.Option<string>,
  standardOnly: boolean,
  images: boolean,
  transport: Transport,
): Effect.Effect<Built> =>
  makeCompatLanguageModel({
    moduleName: selection.provider,
    chatUrl: chatCompletionsUrl(url),
    model: selection.modelId,
    standardOnly,
    images,
    ...compatFetch(transport),
    ...Option.match(key, { onNone: () => ({}), onSome: (apiKey) => ({ apiKey }) }),
  }).pipe(Effect.map((svc) => ({ svc, settings: Option.none(), prependClaudeCode: false, images, route: "compat" as const })))

/** A configured endpoint first, then a `local` credential's URL, then the built-in providers. */
const buildProviderService = (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
  services: ProviderServices,
): Building<Built> => {
  const endpoint = Option.fromNullishOr(services.endpoints[selection.provider])
  if (Option.isSome(endpoint)) {
    const configured = endpoint.value
    return Effect.flatMap(endpointKey(selection, configured, key), (own) =>
      endpointModel(selection, configured.url, own, configured.standardOnly ?? true, configured.images ?? false, services.transport))
  }
  if (credential?.type === "local" && credential.baseUrl !== undefined) {
    return endpointModel(selection, credential.baseUrl, Option.none(), true, false, services.transport)
  }
  return buildBuiltInProvider(selection, credential, key, services)
}

/** What a route builder is given: the selection, its model's profile, the credential and its key, the transport, the subscription's sessions. */
interface RouteCall {
  readonly selection: ModelSelection
  readonly model: ModelProfile
  readonly credential: Credential | undefined
  readonly key: Redacted.Redacted<string>
  readonly transport: Transport
  readonly sessions: Option.Option<OpenAiCodexSessions>
}

/** Anthropic's Messages API over an API key, or over the subscription's OAuth token, whose calls take the Claude Code block first. */
const anthropicModel = ({ selection, credential, key }: RouteCall): Building<RouteModel> => {
  const oauth = credential?.type === "oauth"
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
    Effect.map((svc) => ({ svc, settings: Option.some({ systemPrelude: oauth ? CLAUDE_CODE_SYSTEM : null }), prependClaudeCode: oauth })),
  )
}

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
      return OpenAiClient.make({ apiKey: key, ...Option.match(route.apiUrl, { onNone: () => ({}), onSome: (apiUrl) => ({ apiUrl }) }) }).pipe(
        Effect.flatMap((client) =>
          OpenAiLanguageModel.make({ model: selection.modelId, config }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client)),
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
const chatModel = (route: ChatRoute, { selection, model, key, transport }: RouteCall): Building<RouteModel> =>
  makeCompatLanguageModel({
    moduleName: route.moduleName,
    chatUrl: route.chatUrl,
    apiKey: Redacted.value(key),
    model: selection.modelId,
    standardOnly: route.standardOnly,
    usage: route.usage,
    images: model.images,
    ...compatFetch(transport),
  }).pipe(Effect.map((svc) => ({ svc, settings: Option.none(), prependClaudeCode: false })))

/** A built-in provider's model, by the route its profile names; every route needs a key. */
const buildBuiltInProvider = (
  selection: ModelSelection,
  credential: Credential | undefined,
  key: Redacted.Redacted<string> | undefined,
  { transport, sessions }: ProviderServices,
): Building<Built> =>
  Option.match(profileOf(selection.provider), {
    onNone: () => Effect.fail(notWired(selection)),
    onSome: (profile) => Option.match(Option.fromNullishOr(key), {
      onNone: () => Effect.fail(missingKey(selection)),
      onSome: (found) => {
        const call: RouteCall = { selection, model: profile.modelOf(selection.modelId), credential, key: found, transport, sessions }
        const route = profile.routeOf(selection.modelId)
        const built: Building<RouteModel> = Match.valueTags(route, {
          anthropic: () => anthropicModel(call),
          "openai-responses": (responses) => responsesModel(responses, call),
          "openai-codex": () => codexModel(call),
          compat: (chat) => chatModel(chat, call),
        })
        return Effect.map(built, (routed) => ({ ...routed, images: call.model.images, route: route._tag }))
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
): Effect.Effect<BuiltProvider, AuthError, HttpClient.HttpClient | Scope.Scope> => buildProviderService(selection, credential, key, services).pipe(
  Effect.map((built) => ({
    svc: describeModel(built.images ? built.svc : withImageLabels(built.svc), descriptorOf(selection, built)),
    prependClaudeCode: built.prependClaudeCode,
    images: built.images,
    route: built.route,
  })),
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
): Effect.Effect<BuiltProvider, AuthError, HttpClient.HttpClient | Scope.Scope> =>
  Effect.flatMap(providerServices, (services) => buildProviderOver(services)(selection, credential, key))
