import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, Logger, Option, Redacted, Schema } from "effect"
import { ProviderId } from "@xandreed/core"
import { AuthStore, Credential } from "../ports/auth-store.port.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
import { LocalAuthStoreLive } from "./localAuth.js"

/** A credential as it is stored, secrets in the clear: what a test compares (`toEqual` sees no difference between two `Redacted` values). */
const plain = Schema.encodeSync(Credential)
const plainAll = (all: ReadonlyMap<string, Credential>) => Object.fromEntries([...all].map(([provider, credential]) => [provider, plain(credential)]))

const setup = (global: Record<string, unknown>, local?: Record<string, unknown>) => {
  const home = mkdtempSync(join(tmpdir(), "engine-auth-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "engine-auth-cwd-"))
  mkdirSync(join(home, ".efferent"), { recursive: true })
  writeFileSync(join(home, ".efferent", "auth.json"), JSON.stringify(global))
  if (local !== undefined) {
    mkdirSync(join(cwd, ".efferent"), { recursive: true })
    writeFileSync(join(cwd, ".efferent", "auth.json"), JSON.stringify(local))
  }
  return LocalAuthStoreLive(cwd, home)
}

/** Like `setup` but returns the dirs too (the write-surface tests inspect files). */
const setupWithPaths = (global: Record<string, unknown>, local?: Record<string, unknown>) => {
  const home = mkdtempSync(join(tmpdir(), "engine-auth-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "engine-auth-cwd-"))
  mkdirSync(join(home, ".efferent"), { recursive: true })
  writeFileSync(join(home, ".efferent", "auth.json"), JSON.stringify(global))
  if (local !== undefined) {
    mkdirSync(join(cwd, ".efferent"), { recursive: true })
    writeFileSync(join(cwd, ".efferent", "auth.json"), JSON.stringify(local))
  }
  return { layer: LocalAuthStoreLive(cwd, home), home, cwd }
}

const opencode = ProviderId.make("opencode")

describe("LocalAuthStoreLive", () => {
  test("runtime credentials inherit existing logins and new writes preserve the previous store", async () => {
    const { home, cwd } = setupWithPaths({ opencode: "existing-key" })
    const oldPath = join(home, ".efferent/auth.json")
    const before = readFileSync(oldPath, "utf8")
    await Effect.runPromise(Effect.gen(function* () {
      const auth = yield* AuthStore
      expect(plain(Option.getOrThrow(yield* auth.get(opencode)))).toEqual({ type: "api_key", key: "existing-key" })
      yield* auth.set(opencode, { type: "api_key", key: Redacted.make("replacement-key") })
      expect(Redacted.value(Option.getOrThrow(yield* auth.resolveKey(opencode)))).toBe("replacement-key")
      expect((yield* auth.all).size).toBe(1)
    }).pipe(Effect.provide(LocalAuthStoreLive(cwd, home, ".efferent/runtime", ".efferent"))))
    expect(readFileSync(oldPath, "utf8")).toBe(before)
    expect(statSync(join(home, ".efferent/runtime/auth.json")).mode & 0o777).toBe(0o600)
  })

  test("api_key resolves; legacy flat-string entries read as api keys", async () => {
    const layer = setup({
      opencode: { type: "api_key", key: "sk-modern" },
      google: "legacy-flat-key",
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        const key = yield* auth.resolveKey(opencode)
        expect(Redacted.value(Option.getOrThrow(key))).toBe("sk-modern")
        const legacy = yield* auth.get(ProviderId.make("google"))
        expect(plain(Option.getOrThrow(legacy))).toEqual({ type: "api_key", key: "legacy-flat-key" })
      }).pipe(Effect.provide(layer)),
    )
  })

  test("local auth.json overrides global per provider", async () => {
    const layer = setup(
      { opencode: { type: "api_key", key: "global-key" } },
      { opencode: { type: "api_key", key: "local-key" } },
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        const key = yield* auth.resolveKey(opencode)
        expect(Redacted.value(Option.getOrThrow(key))).toBe("local-key")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("unconfigured provider resolves None; a fresh oauth token is used as-is", async () => {
    const layer = setup({
      anthropic: {
        type: "oauth",
        access: "fresh-access",
        refresh: "r",
        expires: Date.now() + 3_600_000,
      },
    })
    await Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        expect(Option.isNone(yield* auth.resolveKey(opencode))).toBe(true)
        const anthropic = yield* auth.resolveKey(ProviderId.make("anthropic"))
        expect(Redacted.value(Option.getOrThrow(anthropic))).toBe("fresh-access")
      }).pipe(Effect.provide(layer)),
    )
  })

  test("an expired oauth token refreshes through the ModelsTransport the store is built over, and is written back", async () => {
    const { home, cwd } = setupWithPaths({
      anthropic: { type: "oauth", access: "stale", refresh: "refresh-token", expires: Date.now() - 1 },
    })
    const urls: Array<string> = []
    const transport = Layer.succeed(ModelsTransport, ModelsTransport.of({
      fetch: (input) => {
        urls.push(String(input))
        return Promise.resolve(Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }))
      },
    }))
    const key = await Effect.runPromise(Effect.gen(function* () {
      return yield* (yield* AuthStore).resolveKey(ProviderId.make("anthropic"))
    }).pipe(Effect.provide(LocalAuthStoreLive(cwd, home).pipe(Layer.provide(transport)))))
    expect(Option.map(key, Redacted.value)).toEqual(Option.some("fresh-access"))
    expect(urls).toEqual(["https://platform.claude.com/v1/oauth/token"])
    const written = JSON.parse(readFileSync(join(home, ".efferent", "auth.json"), "utf-8")) as Record<string, { readonly access?: unknown }>
    expect(written["anthropic"]?.access).toBe("fresh-access")
  })

  test("a refresh whose response keeps the refresh token stays signed in, the token written back whole", async () => {
    const { home, cwd } = setupWithPaths({
      anthropic: { type: "oauth", access: "stale", refresh: "kept-refresh", expires: Date.now() - 1 },
    })
    const transport = Layer.succeed(ModelsTransport, ModelsTransport.of({
      fetch: () => Promise.resolve(Response.json({ access_token: "fresh-access", expires_in: 3600 })),
    }))
    const stored = await Effect.runPromise(Effect.gen(function* () {
      const auth = yield* AuthStore
      expect(Option.map(yield* auth.resolveKey(ProviderId.make("anthropic")), Redacted.value)).toEqual(Option.some("fresh-access"))
      return yield* auth.get(ProviderId.make("anthropic"))
    }).pipe(Effect.provide(LocalAuthStoreLive(cwd, home).pipe(Layer.provide(transport)))))
    expect(plain(Option.getOrThrow(stored))).toMatchObject({ type: "oauth", access: "fresh-access", refresh: "kept-refresh" })
    const written = JSON.parse(readFileSync(join(home, ".efferent", "auth.json"), "utf-8")) as Record<string, Record<string, unknown>>
    expect(written["anthropic"]?.["refresh"]).toBe("kept-refresh")
    expect(Number.isFinite(written["anthropic"]?.["expires"])).toBe(true)
  })

  test("an expired non-anthropic oauth fails with a clear message (no refresh wired)", async () => {
    const layer = setup({
      openai: { type: "oauth", access: "stale", refresh: "r", expires: Date.now() - 1 },
    })
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const auth = yield* AuthStore
        return yield* auth.resolveKey(ProviderId.make("openai"))
      }).pipe(Effect.provide(layer)),
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("only anthropic and openai-codex tokens can be refreshed")
  })
})

describe("LocalAuthStore — the write surface (:login / :logout)", () => {
  test("set persists to the GLOBAL file, 0600, preserving other providers", async () => {
    const { layer, home } = setupWithPaths({ opencode: "sk-opencode" })
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AuthStore
        yield* store.set(ProviderId.make("openai"), { type: "api_key", key: Redacted.make("sk-test") })
        const all = plainAll(yield* store.all)
        expect(all["openai"]).toEqual({ type: "api_key", key: "sk-test" })
        expect(all["opencode"]).toEqual({ type: "api_key", key: "sk-opencode" })
      }).pipe(Effect.provide(layer)),
    )
    const path = join(home, ".efferent", "auth.json")
    const written = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
    expect(written["openai"]).toEqual({ type: "api_key", key: "sk-test" })
    // legacy flat entry survives the round-trip as a typed credential
    expect(written["opencode"]).toEqual({ type: "api_key", key: "sk-opencode" })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("remove clears the provider from EVERY tier that holds it", async () => {
    const { layer, home, cwd } = setupWithPaths(
      { openai: { type: "api_key", key: "global" } },
      { openai: { type: "api_key", key: "local-override" } },
    )
    await Effect.runPromise(
      Effect.gen(function* () {
        const store = yield* AuthStore
        yield* store.remove(ProviderId.make("openai"))
        const all = yield* store.all
        expect(all.has("openai")).toBe(false)
      }).pipe(Effect.provide(layer)),
    )
    const globalFile = JSON.parse(
      readFileSync(join(home, ".efferent", "auth.json"), "utf-8"),
    ) as Record<string, unknown>
    const localFile = JSON.parse(
      readFileSync(join(cwd, ".efferent", "auth.json"), "utf-8"),
    ) as Record<string, unknown>
    expect("openai" in globalFile).toBe(false)
    expect("openai" in localFile).toBe(false)
  })

  test("concurrent logins in one process all land, through temp files of their own", async () => {
    const { layer, home } = setupWithPaths({ opencode: "sk-opencode" })
    const providers = ["openai", "google", "anthropic", "groq", "mistral", "xai"]
    const all = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      yield* Effect.forEach(providers, (provider) => store.set(ProviderId.make(provider), { type: "api_key", key: Redacted.make(`sk-${provider}`) }), { concurrency: "unbounded" })
      return yield* store.all
    }).pipe(Effect.provide(layer)))
    expect([...all.keys()].toSorted()).toEqual(["opencode", ...providers].toSorted())
    expect(readdirSync(join(home, ".efferent"))).toEqual(["auth.json"])
  })

  test("an entry this version cannot read is not listed, and a write keeps it as it is", async () => {
    const future = { type: "passkey", handle: "h-1" }
    const { layer, home } = setupWithPaths({ opencode: "sk-opencode", acme: future })
    const all = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      yield* store.set(ProviderId.make("openai"), { type: "api_key", key: Redacted.make("sk-openai") })
      return yield* store.all
    }).pipe(Effect.provide(layer)))
    expect([...all.keys()].toSorted()).toEqual(["openai", "opencode"])
    const written = JSON.parse(readFileSync(join(home, ".efferent", "auth.json"), "utf-8")) as Record<string, unknown>
    expect(written["acme"]).toEqual(future)
  })

  test("each kind reads with its optional fields, fields it does not know left out", async () => {
    const layer = setup({
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acct", installationId: "inst", scope: "openid" },
      ollama: { type: "local", baseUrl: "http://localhost:11434" },
      opencode: { type: "api_key", key: "sk-opencode", label: "work" },
    })
    const all = await Effect.runPromise(Effect.flatMap(Effect.service(AuthStore), (store) => store.all).pipe(Effect.provide(layer)))
    expect(plainAll(all)).toEqual({
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acct", installationId: "inst" },
      ollama: { type: "local", baseUrl: "http://localhost:11434" },
      opencode: { type: "api_key", key: "sk-opencode" },
    })
  })

  test("an entry with a field of the wrong type is not read without that field: it is not listed, and a write keeps it as it is", async () => {
    const mistyped = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000, accountId: 42 }
    const { layer, home } = setupWithPaths({ "openai-codex": mistyped, opencode: "sk-opencode" })
    const read = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      const codex = yield* store.get(ProviderId.make("openai-codex"))
      yield* store.set(ProviderId.make("openai"), { type: "api_key", key: Redacted.make("sk-openai") })
      return { codex, providers: [...(yield* store.all).keys()].toSorted() }
    }).pipe(Effect.provide(layer)))
    expect(read).toEqual({ codex: Option.none(), providers: ["openai", "opencode"] })
    const written = JSON.parse(readFileSync(join(home, ".efferent", "auth.json"), "utf-8")) as Record<string, unknown>
    expect(written["openai-codex"]).toEqual(mistyped)
  })
})

describe("LocalAuthStore — secrets are Redacted in memory and in the clear on disk", () => {
  test("a 0.14 auth.json reads: an oauth entry and a flat string, every secret Redacted holding its value", async () => {
    const layer = setup({
      anthropic: { type: "oauth", access: "sk-ant-access", refresh: "sk-ant-refresh", expires: 4_102_444_800_000, accountId: "acct" },
      opencode: "sk-flat-0.14",
    })
    const read = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      const anthropic = Option.getOrThrow(yield* store.get(ProviderId.make("anthropic")))
      const flat = Option.getOrThrow(yield* store.get(opencode))
      return { anthropic, flat, all: yield* store.all, key: yield* store.resolveKey(opencode) }
    }).pipe(Effect.provide(layer)))
    expect(read.anthropic.type === "oauth" && [read.anthropic.access, read.anthropic.refresh].every(Redacted.isRedacted)).toBe(true)
    expect(read.flat.type === "api_key" && Redacted.isRedacted(read.flat.key)).toBe(true)
    expect(plainAll(read.all)).toEqual({
      anthropic: { type: "oauth", access: "sk-ant-access", refresh: "sk-ant-refresh", expires: 4_102_444_800_000, accountId: "acct" },
      opencode: { type: "api_key", key: "sk-flat-0.14" },
    })
    expect(Option.map(read.key, Redacted.value)).toEqual(Option.some("sk-flat-0.14"))
  })

  test("a login, a refresh and a logout write every other provider's entry back byte for byte, never <redacted>", async () => {
    const original: Record<string, unknown> = {
      opencode: { type: "api_key", key: "sk-opencode-kept" },
      anthropic: { type: "oauth", access: "stale-access", refresh: "anthropic-refresh", expires: Date.now() - 1 },
      "openai-codex": { type: "oauth", access: "codex-access", refresh: "codex-refresh", expires: 4_102_444_800_000, accountId: "acct", installationId: "inst" },
      google: "legacy-flat-key",
      ollama: { type: "local", baseUrl: "http://localhost:11434" },
      acme: { type: "passkey", handle: "h-1" },
    }
    const { home, cwd } = setupWithPaths(original)
    const path = join(home, ".efferent", "auth.json")
    const transport = Layer.succeed(ModelsTransport, ModelsTransport.of({
      fetch: () => Promise.resolve(Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 })),
    }))
    const entries = () => Effect.sync(() => {
      const text = readFileSync(path, "utf-8")
      const record = JSON.parse(text) as Record<string, unknown>
      return { text, entries: Object.fromEntries(Object.entries(record).map(([provider, entry]) => [provider, JSON.stringify(entry)])) }
    })
    const kept = (provider: string) => JSON.stringify(provider === "google" ? { type: "api_key", key: "legacy-flat-key" } : original[provider])
    const files = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      yield* store.set(ProviderId.make("openai"), { type: "api_key", key: Redacted.make("sk-openai-login") })
      const login = yield* entries()
      yield* store.resolveKey(ProviderId.make("anthropic"))
      const refresh = yield* entries()
      yield* store.remove(opencode)
      const logout = yield* entries()
      return { login, refresh, logout }
    }).pipe(Effect.provide(LocalAuthStoreLive(cwd, home).pipe(Layer.provide(transport)))))
    const others = ["openai-codex", "google", "ollama", "acme"]
    expect(others.map((provider) => files.login.entries[provider])).toEqual(others.map(kept))
    expect([files.login.entries["opencode"], files.login.entries["anthropic"], files.login.entries["openai"]]).toEqual([kept("opencode"), kept("anthropic"), JSON.stringify({ type: "api_key", key: "sk-openai-login" })])
    expect([...others, "opencode", "openai"].map((provider) => files.refresh.entries[provider])).toEqual([...[...others, "opencode"].map(kept), files.login.entries["openai"]])
    expect(JSON.parse(files.refresh.entries["anthropic"]!)).toMatchObject({ type: "oauth", access: "fresh-access", refresh: "fresh-refresh" })
    expect(Object.keys(files.logout.entries).toSorted()).toEqual(["acme", "anthropic", "google", "ollama", "openai", "openai-codex"])
    expect(["anthropic", "openai", ...others].map((provider) => files.logout.entries[provider])).toEqual(["anthropic", "openai", ...others].map((provider) => files.refresh.entries[provider]))
    expect([files.login.text, files.refresh.text, files.logout.text].join("\n")).not.toContain("redacted")
  })

  test("a credential read from the file prints as <redacted>: as a string, as JSON, in a log line and in a logged failure", async () => {
    const layer = setup({ opencode: { type: "api_key", key: "sk-never-printed" }, anthropic: { type: "oauth", access: "at-never-printed", refresh: "rt-never-printed", expires: 1 } })
    const logged: Array<string> = []
    const capture = Logger.layer([Logger.make((options) => logged.push(Logger.formatSimple.log(options)))])
    const printed = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      const credential = Option.getOrThrow(yield* store.get(opencode))
      const all = yield* store.all
      yield* Effect.logWarning("the stored credentials", credential, all)
      yield* Effect.fail(Option.getOrThrow(yield* store.get(ProviderId.make("anthropic")))).pipe(
        Effect.tapCause((cause) => Effect.logError("the call failed", cause)),
        Effect.ignore({ log: "Debug", message: "expected" }),
      )
      return [String(credential.type === "api_key" ? credential.key : ""), JSON.stringify(credential), JSON.stringify(Object.fromEntries(all))]
    }).pipe(Effect.provide(layer), Effect.provide(capture)))
    expect(printed[0]).toBe("<redacted>")
    expect([...printed, ...logged].join("\n")).not.toContain("never-printed")
    expect(logged.join("\n")).toContain("<redacted>")
  })

  test("a secret that is not Redacted (from untyped code) is refused, the file left as it was and the value never repeated", async () => {
    const { layer, home } = setupWithPaths({ opencode: { type: "api_key", key: "sk-opencode" } })
    const path = join(home, ".efferent", "auth.json")
    const before = readFileSync(path, "utf-8")
    const untyped = (credential: unknown): Credential => credential as never
    const failures = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      return yield* Effect.forEach([
        untyped({ type: "api_key", key: "sk-plain-login" }),
        untyped({ type: "oauth", access: Redacted.make("a"), refresh: "sk-plain-refresh", expires: 1 }),
      ], (credential) => Effect.flip(store.set(ProviderId.make("openai"), credential)), { concurrency: 1 })
    }).pipe(Effect.provide(layer)))
    expect(failures.map((failure) => [failure._tag, failure.provider])).toEqual([["AuthError", "openai"], ["AuthError", "openai"]])
    expect(failures[0]?.message).toContain("must be Redacted values")
    expect(JSON.stringify(failures)).not.toContain("sk-plain")
    expect(readFileSync(path, "utf-8")).toBe(before)
  })
})

describe("LocalAuthStore — a file it cannot use", () => {
  test("a corrupt auth.json fails every call with auth.corrupt and is left as it was", async () => {
    const { layer, home } = setupWithPaths({})
    const path = join(home, ".efferent", "auth.json")
    writeFileSync(path, "{ \"anthropic\": ")
    const failures = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* AuthStore
      return yield* Effect.all([
        Effect.flip(store.get(opencode)),
        Effect.flip(store.all),
        Effect.flip(store.resolveKey(opencode)),
        Effect.flip(store.set(opencode, { type: "api_key", key: Redacted.make("sk-new") })),
        Effect.flip(store.remove(opencode)),
      ])
    }).pipe(Effect.provide(layer)))
    expect(failures.map((failure) => [failure._tag, failure.code])).toEqual(failures.map(() => ["AuthError", "auth.corrupt"]))
    expect(failures[0]?.message).toContain(path)
    expect(readFileSync(path, "utf-8")).toBe("{ \"anthropic\": ")
  })

  test("a file that cannot be read, or holds no JSON object, is corrupt too; a missing one is empty", async () => {
    const home = mkdtempSync(join(tmpdir(), "engine-auth-home-"))
    const cwd = mkdtempSync(join(tmpdir(), "engine-auth-cwd-"))
    const run = <A>(effect: Effect.Effect<A, unknown, AuthStore>) => Effect.runPromise(effect.pipe(Effect.provide(LocalAuthStoreLive(cwd, home))))
    expect((await run(Effect.flatMap(Effect.service(AuthStore), (store) => store.all))).size).toBe(0)
    // A directory where the file should be: reading it fails with EISDIR.
    mkdirSync(join(home, ".efferent", "auth.json"), { recursive: true })
    mkdirSync(join(cwd, ".efferent"), { recursive: true })
    writeFileSync(join(cwd, ".efferent", "auth.json"), "[\"sk-in-a-list\"]")
    const unreadable = await run(Effect.flip(Effect.flatMap(Effect.service(AuthStore), (store) => store.get(opencode))))
    expect([unreadable.code, unreadable.message.includes("could not be read")]).toEqual(["auth.corrupt", true])
    rmSync(join(home, ".efferent", "auth.json"), { recursive: true })
    const notAnObject = await run(Effect.flip(Effect.flatMap(Effect.service(AuthStore), (store) => store.get(opencode))))
    expect([notAnObject.code, notAnObject.message.includes("does not hold a JSON object")]).toEqual(["auth.corrupt", true])
  })
})
