import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigProvider, Context, Effect, Option, Redacted, Schema } from "effect"
import { LanguageModel } from "effect/ai"
import {
  AuthStore,
  authStoreConformance,
  ModelCatalog,
  modelCatalogConformance,
  ProviderId,
  SessionEnvironment,
  SettingsStore,
  settingsStoreConformance,
  UtilityLlm,
} from "@xandreed/core"
import type { ConformanceCheck } from "@xandreed/core"
import { HostCredentials } from "./ports/host-credentials.port.js"
import { modelsPlugin } from "./plugin.adapter.js"

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
    expect(modelsPlugin.optional).toEqual([HostCredentials.key])
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
    expect(refused).toMatchObject({ code: "plugin.activation", plugin: "@xandreed/plugin-models" })
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
