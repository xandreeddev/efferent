import { homedir } from "node:os"
import { LanguageModel } from "effect/ai"
import { Config as EffectConfig, Context, Effect, Layer, Match, Option, Redacted, Schema } from "effect"
import { AuthStore, definePlugin, EngineSettings, HarnessError, ModelCatalog, SessionEnvironment, SettingsError, SettingsStore, UtilityLlm } from "@xandreed/core"
import type { Credential } from "@xandreed/core"
import { CredentialInputs } from "./auth/credential-input.entity.js"
import { credentialsOf } from "./auth/credential-input.entity.functions.js"
import { LocalAuthStoreLive } from "./auth/localAuth.js"
import { MemoryAuthStoreLive } from "./auth/memory-auth.adapter.js"
import { LanguageModelLive } from "./llm/router.js"
import { UtilityLlmLive } from "./llm/utilityLlm.js"
import { ConfiguredModelCatalogLive } from "./llm/modelCatalog.js"
import { LocalSettingsStoreLive } from "./settings/localSettings.js"
import { MemorySettingsStoreLive } from "./settings/memory-settings.adapter.js"
import { HostCredentials } from "./ports/host-credentials.port.js"
import { CurrentModelEndpoints, ModelEndpoints } from "./ports/model-endpoints.port.js"
import { ModelsTransport } from "./ports/models-transport.port.js"
import { ProxyUrlOption } from "./transport/http-proxy.entity.js"
import { modelsTransportFor } from "./transport/models-transport.adapter.js"

const Config = Schema.Struct({
  model: Schema.String,
  fastModel: Schema.String,
  fallbackModel: Schema.String,
  /** Local storage only: read the settings and sign-ins of `~/.efferent` and `<workspace>/.efferent` as fallbacks. */
  inheritPrevious: Schema.Boolean,
  endpoints: ModelEndpoints,
  /** `local`: settings and credentials in `.efferent` files; `memory`: in memory only, never read from or written to disk. */
  storage: Schema.Literals(["local", "memory"]),
  /** Memory storage only: credentials by provider id, secrets as `Redacted` values. */
  credentials: CredentialInputs,
  /** Memory storage only: provider id → the environment variable holding its API key, read when the plugin starts. */
  credentialEnv: Schema.Record(Schema.String, Schema.String),
  /** The proxy every model and OAuth call goes through (http:// or https://, credentials allowed, Redacted from code); empty: HTTPS_PROXY / HTTP_PROXY from the environment. */
  proxy: ProxyUrlOption,
  /** Hosts that go direct, in NO_PROXY syntax, added to NO_PROXY from the environment; "*" turns the proxy off. Loopback hosts always go direct. */
  noProxy: Schema.String,
  // An unknown key is named, never its value: a misspelt `credentials` may hold a secret.
}).annotate({ messageUnexpectedKey: "not an option of the models plugin" }).check(Schema.makeFilter((config) =>
  config.storage === "memory" || (Object.keys(config.credentials).length === 0 && Object.keys(config.credentialEnv).length === 0)
    ? undefined
    : `credentials and credentialEnv need storage: "memory"`,
))
type Config = typeof Config.Type

const optional = (value: string) => value.length === 0 ? Option.none<string>() : Option.some(value)

/** The settings the options set (`model`, `fastModel`, `fallbackModel`) laid over `previous`. */
const overlaid = (config: Config) => (previous: EngineSettings) => new EngineSettings({
  ...previous,
  model: Option.orElse(optional(config.model), () => previous.model),
  fastModel: Option.orElse(optional(config.fastModel), () => previous.fastModel),
  fallbackModel: Option.orElse(optional(config.fallbackModel), () => previous.fallbackModel),
})

/**
 * `storage: "memory"`: the host's `HostCredentials` (if any), then the API
 * keys `credentialEnv` names, then `credentials`, later winning; writable
 * settings starting at the options. No `homedir()`, no file.
 */
const memoryStores = (config: Config) => Layer.unwrap(Effect.gen(function* () {
  const fromEnv = yield* Effect.forEach(Object.entries(config.credentialEnv), ([provider, name]) =>
    EffectConfig.option(EffectConfig.Redacted(name)).pipe(Effect.map(Option.map((key): readonly [string, Credential] =>
      [provider, { type: "api_key", key: Redacted.value(key) }]))))
  const seed = new Map<string, Credential>([...fromEnv.flatMap(Option.toArray), ...credentialsOf(config.credentials)])
  return Layer.mergeAll(MemoryAuthStoreLive(seed), MemorySettingsStoreLive(overlaid(config)(new EngineSettings({}))))
}))

const readOnly = (what: string) => () => Effect.fail(new SettingsError({ message: `Edit the models plugin configuration to change ${what}` }))

/**
 * `storage: "local"`: credentials in `.efferent/runtime/auth.json` (home,
 * then workspace), with `.efferent/auth.json` as a fallback when
 * `inheritPrevious`; settings from the options, over the `.efferent/config.json`
 * files when `inheritPrevious`, re-read on every `load`. Settings writes are
 * refused: the options are the source.
 */
const localStores = (config: Config, workspace: string) => {
  const home = homedir()
  const files = Effect.service(SettingsStore).pipe(Effect.provide(LocalSettingsStoreLive(workspace, home)))
  const settings = Layer.effect(SettingsStore, Effect.map(files, (stored) => SettingsStore.of({
    load: config.inheritPrevious ? Effect.map(stored.load, overlaid(config)) : Effect.succeed(overlaid(config)(new EngineSettings({}))),
    setRole: readOnly("a model"),
    set: readOnly("settings"),
  })))
  return Layer.mergeAll(settings, LocalAuthStoreLive(workspace, home, ".efferent/runtime", config.inheritPrevious ? ".efferent" : undefined))
}

const optionError = (message: string) => new HarnessError({ code: "config.options", plugin: "@xandreed/plugin-models", message })

/**
 * The network path of every call the plugin makes: the host's own
 * `ModelsTransport` when it provides one (then the `proxy` and `noProxy`
 * options would not apply, so setting them is refused), else the transport
 * the options and the environment's proxy variables call for
 * (`modelsTransportFor`), which fails the plugin on an unusable proxy URL.
 * When no proxy applies there is none, and the calls use the runtime's own
 * fetch as before (a `FetchHttpClient.Fetch` the host provides included).
 */
const transportLayer = (config: Config): Effect.Effect<Layer.Layer<never, HarnessError>, HarnessError> => Effect.flatMap(Effect.serviceOption(ModelsTransport), Option.match({
  onSome: (host) => Redacted.isRedacted(config.proxy) || config.proxy.length > 0 || config.noProxy.length > 0
    ? Effect.fail(optionError("the host provides ModelsTransport, so the proxy and noProxy options would not apply: give the proxy to the host's transport"))
    : Effect.succeed(Layer.succeed(ModelsTransport, host)),
  onNone: () => Effect.succeed(Layer.effectContext(modelsTransportFor({ proxy: config.proxy, noProxy: config.noProxy }).pipe(
    Effect.map(Option.match({
      onNone: () => Context.empty(),
      onSome: (transport): Context.Context<never> => Context.make(ModelsTransport, transport),
    })),
    Effect.mapError((error) => optionError(error.message)),
  ))),
}))

/**
 * The models plugin: the routed `LanguageModel`, the fast `UtilityLlm`, the
 * `ModelCatalog`, and the `AuthStore` and `SettingsStore` they read.
 * Runtime-scoped: built once per `Agent.define`, so credentials, refreshed
 * tokens and settings edits held in memory last across turns. A turn's own
 * services win over it (a per-turn `LanguageModel` replaces the routed one).
 * When a proxy applies (the `proxy` option, else the environment's
 * `https_proxy` / `HTTPS_PROXY` and `http_proxy` / `HTTP_PROXY`), every call
 * it makes (the providers, the OpenAI-compatible endpoints, OAuth token
 * refreshes, the OpenAI subscription's WebSocket) goes through one
 * `ModelsTransport`, the `noProxy` / `NO_PROXY` hosts and loopback direct;
 * so do they through a host's own transport.
 */
export const modelsPlugin = definePlugin({
  id: "@xandreed/plugin-models", version: "0.13.0", scope: "runtime", config: Config,
  defaults: { model: "", fastModel: "", fallbackModel: "", inheritPrevious: true, endpoints: {}, storage: "local", credentials: {}, credentialEnv: {}, proxy: "", noProxy: "" },
  requires: [SessionEnvironment],
  optional: [HostCredentials, ModelsTransport],
  provides: [LanguageModel.LanguageModel, UtilityLlm, AuthStore, SettingsStore, ModelCatalog],
  layer: (config) => Layer.unwrap(Effect.gen(function* () {
    const { workspace } = yield* SessionEnvironment
    const host = yield* Effect.serviceOption(HostCredentials)
    const stores = yield* Match.value(config.storage).pipe(
      Match.when("memory", () => Effect.succeed(memoryStores(config))),
      Match.when("local", () => Option.isSome(host)
        ? Effect.fail(optionError(`the host provides HostCredentials, which needs storage: "memory"`))
        : Effect.succeed(localStores(config, workspace))),
      Match.exhaustive,
    )
    const transport = yield* transportLayer(config)
    // The transport sits beneath everything that calls out: the stores' token refreshes, the routed model and the utility model.
    const base = Layer.mergeAll(stores, Layer.succeed(CurrentModelEndpoints, config.endpoints)).pipe(Layer.provideMerge(transport))
    return Layer.mergeAll(LanguageModelLive, UtilityLlmLive, ConfiguredModelCatalogLive).pipe(Layer.provideMerge(base))
  })),
})
export default modelsPlugin
