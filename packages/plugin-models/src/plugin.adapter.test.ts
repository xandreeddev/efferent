import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Context, Effect, Option, Redacted, Schema } from "effect"
import { AiError, LanguageModel } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import {
  ModelCatalog,
  ProviderId,
  SessionEnvironment,
  UtilityLlm,
} from "@xandreed/core"
import {
  AuthStore,
  authStoreConformance,
  SettingsStore,
  settingsStoreConformance,
} from "@xandreed/core/models"
import { modelCatalogConformance } from "@xandreed/core/conformance"
import type { ConformanceCheck } from "@xandreed/core/conformance"
import { HostCredentials } from "./ports/host-credentials.port.js"
import { ModelsTransport } from "./ports/models-transport.port.js"
import type { ModelsFetch } from "./ports/models-transport.port.js"
import { modelsPlugin } from "./plugin.adapter.js"
import { BUN_WEBSOCKET_PROXY_VERSION } from "./transport/http-proxy.entity.js"
import { atLeastVersion } from "./transport/http-proxy.entity.functions.js"
import { startRecordingProxy } from "./transport/recording-proxy.testing.js"

/** Every temporary directory a test makes, removed once the file's tests ran, whether they passed or not. */
const made: Array<string> = []
const tempDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}
afterAll(() => made.map((dir) => rmSync(dir, { recursive: true, force: true })))

/**
 * The options refused as the agent's graph refuses them (`resolveGraph`):
 * extra keys refused and the input reported, the decode a secret could leak
 * through. `build` decodes without reporting the input.
 */
const graphRefusal = (options: Record<string, unknown>) => Effect.runPromise(Effect.flip(
  Schema.decodeUnknownEffect(modelsPlugin.schema)({ ...modelsPlugin.defaults, ...options }, { onExcessProperty: "error", reportInput: true }),
).pipe(Effect.map(String)))

/** The plugin's services, built over a workspace (and any host services), in the caller's scope. */
const build = (workspace: string, options: Record<string, unknown>, host: Context.Context<never> = Context.empty()) => Effect.gen(function* () {
  const seed = Context.add(host, SessionEnvironment, { workspace })
  return yield* modelsPlugin.build({ ...modelsPlugin.defaults, ...options }, Context.makeUnsafe<never>(seed.mapUnsafe))
})

const failuresOf = (checks: ReadonlyArray<ConformanceCheck>) => Effect.forEach(checks, (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [`${check.name}: ${exit.failure.message}`] : []))).pipe(Effect.map((failed) => failed.flat()))

/** A chat-completions endpoint that records each request's Authorization header and model. */
const chatServer = () => {
  const seen: Array<{ auth: string | null; model: unknown }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const body = await request.json() as { readonly model?: unknown }
      seen.push({ auth: request.headers.get("authorization"), model: body.model })
      return Response.json({ choices: [{ finish_reason: "stop", message: { content: "from the endpoint" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    },
  })
  return { seen, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

describe("models plugin setup continuity", () => {
  test("existing model selection survives; explicit plugin options win; inheritance can be disabled", async () => {
    const workspace = tempDir("efferent-model-setup-")
    mkdirSync(join(workspace, ".efferent"))
    writeFileSync(join(workspace, ".efferent/config.json"), JSON.stringify({ model: "fixture:existing", fastModel: "fixture:fast" }))
    const load = (options: Record<string, unknown>) => Effect.scoped(Effect.gen(function* () {
      const services = yield* build(workspace, options)
      return yield* Option.getOrThrow(Context.getOption(services, SettingsStore)).load
    }))
    await Effect.runPromise(Effect.gen(function* () {
      const inherited = yield* load({})
      expect(Option.getOrThrow(inherited.model)).toBe("fixture:existing")
      expect(Option.getOrThrow(inherited.fastModel)).toBe("fixture:fast")
      expect(Option.getOrThrow((yield* load({ model: "fixture:override" })).model)).toBe("fixture:override")
      expect(Option.isNone((yield* load({ inheritPrevious: false })).model)).toBe(true)
    }))
  })

  test("local settings are read through: a config.json edit between two loads is seen, under the options", async () => {
    const workspace = tempDir("efferent-model-reread-")
    mkdirSync(join(workspace, ".efferent"))
    writeFileSync(join(workspace, ".efferent/config.json"), JSON.stringify({ model: "fixture:first" }))
    const loads = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const settings = Context.getUnsafe(yield* build(workspace, { fastModel: "fixture:pinned" }), SettingsStore)
      const first = yield* settings.load
      writeFileSync(join(workspace, ".efferent/config.json"), JSON.stringify({ model: "fixture:second", fastModel: "fixture:ignored" }))
      const second = yield* settings.load
      return [first, second].map((loaded) => [Option.getOrNull(loaded.model), Option.getOrNull(loaded.fastModel)])
    })))
    expect(loads).toEqual([["fixture:first", "fixture:pinned"], ["fixture:second", "fixture:pinned"]])
  })
})

describe("models plugin endpoints", () => {
  test("a configured endpoint serves the plugin's model without a key", async () => {
    const workspace = tempDir("efferent-model-endpoint-")
    const server = chatServer()
    const options = { model: "fixture-endpoint:tiny", inheritPrevious: false, endpoints: { "fixture-endpoint": { url: server.url } } }
    const text = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const model = Context.getUnsafe(yield* build(workspace, options), LanguageModel.LanguageModel)
      return (yield* model.generateText({ prompt: "hi" })).text
    })).pipe(Effect.ensuring(Effect.sync(server.stop))))
    expect(text).toBe("from the endpoint")
    expect(server.seen).toEqual([{ auth: null, model: "tiny" }])
  })
})

describe("models plugin scope", () => {
  test("is built once per agent (runtime) and may use the host's HostCredentials", () => {
    expect(modelsPlugin.scope).toBe("runtime")
    expect(modelsPlugin.requires).toEqual([SessionEnvironment.key])
    expect(modelsPlugin.optional).toEqual([HostCredentials.key, ModelsTransport.key])
  })
})

describe("models plugin storage: memory", () => {
  test("serves calls, the catalog, logins, role edits and logouts without reading or writing a file", async () => {
    const home = tempDir("efferent-memory-home-")
    const workspace = tempDir("efferent-memory-workspace-")
    const server = chatServer()
    const previousHome = process.env["HOME"]
    process.env["HOME"] = home
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(workspace, {
        storage: "memory", model: "stub:general", fastModel: "stub:fast",
        endpoints: { stub: { url: server.url } },
        credentials: { stub: { type: "api_key", key: Redacted.make("memory-key") }, opencode: { type: "api_key", key: Redacted.make("opencode-key") } },
      })
      const model = Context.getUnsafe(services, LanguageModel.LanguageModel)
      const auth = Context.getUnsafe(services, AuthStore)
      const settings = Context.getUnsafe(services, SettingsStore)
      yield* model.generateText({ prompt: "hi" })
      yield* Context.getUnsafe(services, UtilityLlm).complete("a title")
      const catalog = (yield* Context.getUnsafe(services, ModelCatalog).list).map((entry) => entry.selection)
      yield* auth.set(ProviderId.make("stub"), { type: "api_key", key: "second-key" })
      yield* settings.setRole("general", Option.some("stub:edited"))
      yield* model.generateText({ prompt: "again" })
      yield* auth.remove(ProviderId.make("opencode"))
      return { catalog, all: [...(yield* auth.all).keys()], model: Option.getOrNull((yield* settings.load).model) }
    })).pipe(Effect.ensuring(Effect.sync(() => {
      server.stop()
      if (previousHome === undefined) delete process.env["HOME"]
      else process.env["HOME"] = previousHome
    }))))
    expect(server.seen).toEqual([
      { auth: "Bearer memory-key", model: "general" },
      { auth: "Bearer memory-key", model: "fast" },
      { auth: "Bearer second-key", model: "edited" },
    ])
    expect(result.catalog).toContain("opencode:glm-5.2")
    expect(result.all).toEqual(["stub"])
    expect(result.model).toBe("stub:edited")
    expect(readdirSync(home)).toEqual([])
    expect(readdirSync(workspace)).toEqual([])
  })

  test("ignores inheritPrevious: a workspace's config.json is neither read nor changed", async () => {
    const workspace = tempDir("efferent-memory-inherit-")
    mkdirSync(join(workspace, ".efferent"))
    writeFileSync(join(workspace, ".efferent/config.json"), JSON.stringify({ model: "fixture:on-disk", fastModel: "fixture:on-disk-fast" }))
    const loaded = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const settings = Context.getUnsafe(yield* build(workspace, { storage: "memory", inheritPrevious: true, model: "fixture:option" }), SettingsStore)
      yield* settings.set("maxAttempts", Option.some("3"))
      return yield* settings.load
    })))
    expect(Option.getOrNull(loaded.model)).toBe("fixture:option")
    expect(Option.isNone(loaded.fastModel)).toBe(true)
    expect(readdirSync(join(workspace, ".efferent"))).toEqual(["config.json"])
    expect(await Bun.file(join(workspace, ".efferent/config.json")).json()).toEqual({ model: "fixture:on-disk", fastModel: "fixture:on-disk-fast" })
  })

  test("seeds the host's credentials, then the keys credentialEnv names, then credentials", async () => {
    const host = Context.make(HostCredentials, HostCredentials.of({
      load: Effect.succeed(new Map([
        ["anthropic", { type: "api_key" as const, key: Redacted.make("host-anthropic") }],
        ["google", { type: "api_key" as const, key: Redacted.make("host-google") }],
        ["openai", { type: "api_key" as const, key: Redacted.make("host-openai") }],
      ])),
      save: () => Effect.void,
    }))
    const env = ConfigProvider.fromEnv({ env: { FIXTURE_GOOGLE_KEY: "env-google", FIXTURE_OPENAI_KEY: "env-openai" } })
    const all = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(".", {
        storage: "memory",
        credentialEnv: { google: "FIXTURE_GOOGLE_KEY", openai: "FIXTURE_OPENAI_KEY", opencode: "FIXTURE_UNSET_KEY" },
        credentials: { openai: { type: "api_key", key: Redacted.make("option-openai") } },
      }, host)
      return Object.fromEntries(yield* Context.getUnsafe(services, AuthStore).all)
    })).pipe(Effect.provideService(ConfigProvider.ConfigProvider, env)))
    expect(all).toEqual({
      anthropic: { type: "api_key", key: "host-anthropic" },
      google: { type: "api_key", key: "env-google" },
      openai: { type: "api_key", key: "option-openai" },
    })
  })

  test("the stores conform: the AuthStore, a writable SettingsStore and the catalog", async () => {
    const failures = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(".", { storage: "memory", model: "opencode:glm-5.1", credentials: { opencode: { type: "api_key", key: Redacted.make("k") } } })
      return [
        ...yield* failuresOf(authStoreConformance(Context.getUnsafe(services, AuthStore))),
        ...yield* failuresOf(settingsStoreConformance(Context.getUnsafe(services, SettingsStore), { writable: true })),
        ...yield* failuresOf(modelCatalogConformance(Context.getUnsafe(services, ModelCatalog), { includes: ["opencode:glm-5.2"] })),
      ]
    })))
    expect(failures).toEqual([])
  })
})

describe("models plugin storage: local", () => {
  test("its SettingsStore is read-only and conforms as such", async () => {
    const workspace = tempDir("efferent-local-kit-")
    const failures = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(workspace, { inheritPrevious: false, model: "opencode:glm-5.1" })
      return yield* failuresOf(settingsStoreConformance(Context.getUnsafe(services, SettingsStore), { writable: false }))
    })))
    expect(failures).toEqual([])
  })

  test("refuses credentials and credentialEnv, without repeating a secret", async () => {
    const refused = await Effect.runPromise(Effect.flip(Effect.scoped(build(".", {
      credentials: { anthropic: { type: "api_key", key: Redacted.make("sk-local-secret") } },
    }))))
    expect(refused.message).toContain(`credentials and credentialEnv need storage: "memory"`)
    const graph = await graphRefusal({ credentials: { anthropic: { type: "api_key", key: Redacted.make("sk-local-secret") } } })
    expect(graph).toContain(`credentials and credentialEnv need storage: "memory"`)
    expect(graph).not.toContain("sk-local-secret")
    const envRefused = await Effect.runPromise(Effect.flip(Effect.scoped(build(".", { credentialEnv: { anthropic: "ANTHROPIC_API_KEY" } }))))
    expect(envRefused.message).toContain(`need storage: "memory"`)
  })

  test("refuses a host's HostCredentials", async () => {
    const host = Context.make(HostCredentials, HostCredentials.of({ load: Effect.succeed(new Map()), save: () => Effect.void }))
    const refused = await Effect.runPromise(Effect.flip(Effect.scoped(build(".", { inheritPrevious: false }, host))))
    expect(refused).toMatchObject({ code: "config.options", plugin: "@xandreed/plugin-models" })
    expect(refused.message).toContain(`HostCredentials, which needs storage: "memory"`)
  })
})

describe("models plugin options with secrets", () => {
  test("a plain-string secret is refused without being repeated", async () => {
    const options = {
      storage: "memory",
      credentials: { anthropic: { type: "oauth", access: "plain-access-secret", refresh: Redacted.make("r"), expires: 1 } },
    }
    const refused = await Effect.runPromise(Effect.flip(Effect.scoped(build(".", options))))
    expect(refused.message).toContain("a secret must be a Redacted value")
    const graph = await graphRefusal(options)
    expect(graph).toContain("a secret must be a Redacted value")
    expect(graph).not.toContain("plain-access-secret")
  })

  test("a field a credential does not have is named, never its value", async () => {
    const misspelt = await graphRefusal({ storage: "memory", credentials: { anthropic: { type: "api_key", apiKey: "sk-misspelt-secret" } } })
    const extra = await graphRefusal({ storage: "memory", credentials: { anthropic: { type: "api_key", key: Redacted.make("k"), extra: "sk-extra-secret" } } })
    expect(misspelt).toContain("not a field of a credential")
    expect(misspelt).toContain(`["apiKey"]`)
    expect(misspelt).not.toContain("sk-misspelt-secret")
    expect(extra).not.toContain("sk-extra-secret")
  })
})

/** A host's own transport: records every URL its fetch is asked for, and answers with `respond`. */
const hostTransport = (respond: (url: string) => Response) => {
  const urls: Array<string> = []
  const fetch: ModelsFetch = (input) => {
    const url = String(input)
    urls.push(url)
    return Promise.resolve(respond(url))
  }
  return { urls, services: Context.make(ModelsTransport, ModelsTransport.of({ fetch })) }
}

/** The plugin's services under an empty environment: no proxy variable leaks in from the machine running the tests. */
const noEnvironment = Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} }))

describe("models plugin proxy", () => {
  test("model and utility calls go through the proxy option to a host only the proxy reaches", async () => {
    const server = chatServer()
    const proxy = await startRecordingProxy()
    const port = new URL(server.url).port
    const replies = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(".", {
        storage: "memory", model: "stub:general", fastModel: "stub:fast",
        endpoints: { stub: { url: `http://models.proxy-test.invalid:${port}/v1` } },
        credentials: { stub: { type: "api_key", key: Redacted.make("stub-key") } },
        proxy: proxy.url,
      })
      const reply = yield* Context.getUnsafe(services, LanguageModel.LanguageModel).generateText({ prompt: "hi" })
      const title = yield* Context.getUnsafe(services, UtilityLlm).complete("a title")
      return [reply.text, title.text]
    })).pipe(noEnvironment, Effect.ensuring(Effect.promise(proxy.close)), Effect.ensuring(Effect.sync(server.stop))))
    expect(replies).toEqual(["from the endpoint", "from the endpoint"])
    expect(proxy.seen.map((request) => request.target)).toEqual([
      `http://models.proxy-test.invalid:${port}/v1/chat/completions`,
      `http://models.proxy-test.invalid:${port}/v1/chat/completions`,
    ])
    expect(server.seen).toEqual([{ auth: "Bearer stub-key", model: "general" }, { auth: "Bearer stub-key", model: "fast" }])
  })

  test("HTTP_PROXY from the environment applies, and noProxy sends a host direct", async () => {
    const server = chatServer()
    const proxy = await startRecordingProxy()
    const port = new URL(server.url).port
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(".", {
        storage: "memory", model: "stub:general",
        endpoints: { stub: { url: `http://models.proxy-test.invalid:${port}/v1` }, direct: { url: `http://direct.proxy-test.invalid:${port}/v1` } },
        noProxy: "direct.proxy-test.invalid",
      })
      const model = Context.getUnsafe(services, LanguageModel.LanguageModel)
      const proxied = yield* model.generateText({ prompt: "hi" })
      yield* Context.getUnsafe(services, SettingsStore).setRole("general", Option.some("direct:general"))
      // Direct, the .invalid host does not resolve: the call fails, and the proxy never sees it.
      const direct = yield* Effect.flip(model.generateText({ prompt: "hi" }).pipe(Effect.timeout("20 seconds")))
      return { proxied: proxied.text, direct: String(direct) }
    })).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HTTP_PROXY: proxy.url } })),
      Effect.ensuring(Effect.promise(proxy.close)),
      Effect.ensuring(Effect.sync(server.stop)),
    ))
    expect(outcome.proxied).toBe("from the endpoint")
    expect(outcome.direct).not.toContain("through the proxy")
    expect(proxy.seen.map((request) => request.target)).toEqual([`http://models.proxy-test.invalid:${port}/v1/chat/completions`])
  }, 30_000)

  test("HTTPS_PROXY from the environment carries an SDK provider's call (CONNECT)", async () => {
    const proxy = await startRecordingProxy()
    const error = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(".", {
        storage: "memory", model: "anthropic:claude-test",
        credentials: { anthropic: { type: "api_key", key: Redacted.make("anthropic-key") } },
      })
      // The test proxy refuses every host but *.invalid, so the call fails after its CONNECT.
      return yield* Effect.flip(Context.getUnsafe(services, LanguageModel.LanguageModel).generateText({ prompt: "hi" }).pipe(Effect.timeout("20 seconds")))
    })).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: { HTTPS_PROXY: proxy.url } })),
      Effect.ensuring(Effect.promise(proxy.close)),
    ))
    expect(String(error)).not.toContain("TimeoutError")
    expect(proxy.seen.length).toBeGreaterThan(0)
    expect(proxy.seen.every((request) => request.kind === "connect" && request.target === "api.anthropic.com:443")).toBe(true)
  }, 30_000)

  test("without a proxy the plugin adds no transport: a FetchHttpClient.Fetch the host provides still carries the SDK providers' calls", async () => {
    const reached: Array<string> = []
    const hostFetch = Object.assign((input: string | URL | Request) => {
      reached.push(input instanceof Request ? input.url : String(input))
      return Promise.resolve(Response.json({ type: "error", error: { type: "invalid_request_error", message: "answered by the host's fetch" } }, { status: 400 }))
    }, { preconnect: () => undefined })
    const error = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(".", {
        storage: "memory", model: "anthropic:claude-test",
        credentials: { anthropic: { type: "api_key", key: Redacted.make("anthropic-key") } },
      })
      return yield* Effect.flip(Context.getUnsafe(services, LanguageModel.LanguageModel).generateText({ prompt: "hi" }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, hostFetch),
      ))
    })).pipe(noEnvironment))
    expect(String(error)).toContain("answered by the host's fetch")
    expect(reached).toEqual(["https://api.anthropic.com/v1/messages?beta=true"])
  })

  test("a host's ModelsTransport carries the SDK providers' calls, whatever FetchHttpClient.Fetch is around them", async () => {
    const host = hostTransport(() => Response.json({ type: "error", error: { type: "invalid_request_error", message: "refused by the host transport" } }, { status: 400 }))
    const bypassed: Array<string> = []
    const bypass = Object.assign((input: string | URL | Request) => {
      bypassed.push(String(input))
      return Promise.resolve(new Response("bypassed", { status: 500 }))
    }, { preconnect: () => undefined })
    const error = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(".", {
        storage: "memory", model: "anthropic:claude-test",
        credentials: { anthropic: { type: "api_key", key: Redacted.make("anthropic-key") } },
      }, host.services)
      return yield* Effect.flip(Context.getUnsafe(services, LanguageModel.LanguageModel).generateText({ prompt: "hi" }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, bypass),
      ))
    })).pipe(noEnvironment))
    expect(String(error)).toContain("refused by the host transport")
    expect(host.urls).toEqual(["https://api.anthropic.com/v1/messages?beta=true"])
    expect(bypassed).toEqual([])
  })

  test("OAuth token refreshes go through the transport", async () => {
    const host = hostTransport(() => Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }))
    const key = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(".", {
        storage: "memory",
        credentials: { anthropic: { type: "oauth", access: Redacted.make("stale"), refresh: Redacted.make("refresh"), expires: 1 } },
      }, host.services)
      return yield* Context.getUnsafe(services, AuthStore).resolveKey(ProviderId.make("anthropic"))
    })).pipe(noEnvironment))
    expect(Option.map(key, Redacted.value)).toEqual(Option.some("fresh-access"))
    expect(host.urls).toEqual(["https://platform.claude.com/v1/oauth/token"])
  })

  /** An OpenAI subscription call through a recording proxy, which refuses `chatgpt.com`: the call's error, and what the proxy saw. */
  const subscriptionCall = async () => {
    const proxy = await startRecordingProxy()
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* build(".", {
        storage: "memory", model: "openai-codex:gpt-test",
        credentials: { "openai-codex": { type: "oauth", access: Redacted.make("access"), refresh: Redacted.make("refresh"), expires: Date.now() + 3_600_000, accountId: "account" } },
        proxy: proxy.url,
      })
      return yield* Effect.flip(Context.getUnsafe(services, LanguageModel.LanguageModel).generateText({ prompt: "hi" }).pipe(Effect.timeout("20 seconds")))
    })).pipe(noEnvironment, Effect.ensuring(Effect.promise(proxy.close))))
    return { outcome, seen: proxy.seen }
  }
  // CI runs this file on Bun 1.3.6 too, so both sides of the gate run somewhere.
  const tunnels = atLeastVersion(Bun.version, BUN_WEBSOCKET_PROXY_VERSION)

  test.skipIf(tunnels)(`below Bun ${BUN_WEBSOCKET_PROXY_VERSION} the OpenAI subscription refuses a proxied WebSocket instead of connecting directly`, async () => {
    const { outcome, seen } = await subscriptionCall()
    // The LanguageModel's own error, as authentication: not retried, no fallback.
    expect(AiError.isAiError(outcome) && outcome.reason._tag === "AuthenticationError").toBe(true)
    expect(String(outcome)).toContain(`Bun ${Bun.version} cannot send a WebSocket through a proxy`)
    expect(seen).toEqual([])
  }, 30_000)

  test.if(tunnels)(`from Bun ${BUN_WEBSOCKET_PROXY_VERSION} the OpenAI subscription's WebSocket tunnels through the proxy (CONNECT chatgpt.com:443)`, async () => {
    const { outcome, seen } = await subscriptionCall()
    expect(String(outcome)).not.toContain("cannot send a WebSocket through a proxy")
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((request) => request.kind === "connect" && request.target === "chatgpt.com:443")).toBe(true)
  }, 30_000)

  test("an unusable proxy option fails the plugin without repeating its credentials", async () => {
    const refused = await Effect.runPromise(Effect.flip(Effect.scoped(build(".", { proxy: "socks5://user:proxy-secret@proxy:1080" }))).pipe(noEnvironment))
    expect(refused.message).toContain("the proxy option is a socks5:// proxy")
    expect(refused.message).not.toContain("proxy-secret")
  })

  test("a host's ModelsTransport and the proxy options together are refused", async () => {
    const host = hostTransport(() => new Response("unused"))
    const refused = await Effect.runPromise(Effect.flip(Effect.scoped(build(".", { proxy: "http://proxy:3128" }, host.services))).pipe(noEnvironment))
    expect(refused.message).toContain("the host provides ModelsTransport, so the proxy and noProxy options would not apply")
  })
})
