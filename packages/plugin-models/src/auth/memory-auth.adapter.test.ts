import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Clock, Effect, Fiber, Layer, Option, Redacted, Ref } from "effect"
import { ProviderId } from "@xandreed/core"
import { AuthError, AuthStore, authStoreConformance } from "@xandreed/core/models"
import type { AuthStoreConformanceOptions, Credential } from "@xandreed/core/models"
import { HostCredentials } from "../ports/host-credentials.port.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
import { damagedFile, tokenEndpoint as kitTokenEndpoint } from "../testing.js"
import type { CredentialInput } from "./credential-input.entity.js"
import { toCredential } from "./credential-input.entity.functions.js"
import { LocalAuthStoreLive } from "./localAuth.js"
import { MemoryAuthStoreLive } from "./memory-auth.adapter.js"

const anthropic = ProviderId.make("anthropic")
const opencode = ProviderId.make("opencode")
const HOUR = 3_600_000

const runKit = (store: typeof AuthStore.Service, options: AuthStoreConformanceOptions = {}) => authStoreConformance(store, options).map((check) => test(check.name, async () => {
  const exit = await Effect.runPromise(Effect.result(check.run))
  expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
}))

/** The local store over a token endpoint, as the kit runs it: the store, the endpoint's probe and the damaged login file. */
const localKitSubject = (cwd: string, home: string, provider: ProviderId) => {
  const endpoint = kitTokenEndpoint(provider, "kit")
  const transport = Layer.succeed(ModelsTransport, ModelsTransport.of({ fetch: endpoint.fetch }))
  const store = Effect.runSync(Effect.service(AuthStore).pipe(Effect.provide(LocalAuthStoreLive(cwd, home, ".efferent/runtime", ".efferent").pipe(Layer.provide(transport)))))
  return { store, options: { refresh: endpoint.probe, corrupt: damagedFile(join(home, ".efferent", "runtime", "auth.json")) } }
}

describe("MemoryAuthStoreLive conforms to the AuthStore contract", () => {
  const endpoint = kitTokenEndpoint(anthropic, "kit")
  runKit(Effect.runSync(Effect.service(AuthStore).pipe(Effect.provide(MemoryAuthStoreLive(new Map(), { fetch: endpoint.fetch })))), { refresh: endpoint.probe })
})

describe("LocalAuthStoreLive conforms to the AuthStore contract", () => {
  const home = mkdtempSync(join(tmpdir(), "efferent-auth-kit-home-"))
  const cwd = mkdtempSync(join(tmpdir(), "efferent-auth-kit-cwd-"))
  afterAll(() => [home, cwd].map((dir) => rmSync(dir, { recursive: true, force: true })))
  const subject = localKitSubject(cwd, home, ProviderId.make("openai-codex"))
  runKit(subject.store, subject.options)
})

/** A token endpoint: records each request, and answers once `release` resolves (at once by default). */
const tokenEndpoint = (release: Promise<void> = Promise.resolve()) => {
  const requests: Array<string> = []
  const started = Promise.withResolvers<void>()
  const fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
    requests.push(String(init?.body))
    started.resolve()
    await release
    return Response.json({ access_token: `fresh-access-${requests.length}`, refresh_token: `fresh-refresh-${requests.length}`, expires_in: 3600 })
  }, { preconnect: () => {} })
  return { requests, started: started.promise, fetch }
}

/** A host's credential store: what it starts with, and every save it receives. */
const hostWith = (initial: ReadonlyMap<string, CredentialInput>, failSaves = false) => Effect.gen(function* () {
  const saves = yield* Ref.make<ReadonlyArray<readonly [string, Option.Option<Credential>]>>([])
  const layer = Layer.succeed(HostCredentials, HostCredentials.of({
    load: Effect.succeed(initial),
    save: (provider, credential) => failSaves
      ? Effect.fail(new AuthError({ provider, message: "the host store is down" }))
      : Ref.update(saves, (all) => [...all, [provider, Option.map(credential, toCredential)] as const]),
  }))
  return { saves, layer }
})

const expired = (now: number): Credential => ({ type: "oauth", access: "stale-access", refresh: "stale-refresh", expires: now - HOUR })

describe("MemoryAuthStoreLive refreshes in memory", () => {
  test("two calls on one expired token send one refresh, and the host receives the new token", async () => {
    const endpoint = tokenEndpoint()
    const result = await Effect.runPromise(Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const host = yield* hostWith(new Map())
      return yield* Effect.gen(function* () {
        const auth = yield* AuthStore
        const keys = yield* Effect.all([auth.resolveKey(anthropic), auth.resolveKey(anthropic)], { concurrency: "unbounded" })
        const stored = yield* auth.get(anthropic)
        return { keys: keys.map((key) => Option.map(key, Redacted.value)), stored, saves: yield* Ref.get(host.saves) }
      }).pipe(Effect.provide(MemoryAuthStoreLive(new Map([[anthropic, expired(now)]]), { fetch: endpoint.fetch }).pipe(Layer.provide(host.layer))))
    }))
    expect(endpoint.requests.length).toBe(1)
    expect(JSON.parse(endpoint.requests[0]!)).toMatchObject({ grant_type: "refresh_token", refresh_token: "stale-refresh" })
    expect(result.keys).toEqual([Option.some("fresh-access-1"), Option.some("fresh-access-1")])
    expect(Option.getOrThrow(result.stored)).toMatchObject({ type: "oauth", access: "fresh-access-1", refresh: "fresh-refresh-1" })
    expect(result.saves.map(([provider, credential]) => [provider, Option.map(credential, (value) => value.type === "oauth" ? value.access : "")])).toEqual([[anthropic, Option.some("fresh-access-1")]])
  })

  test("a logout during a stalled refresh stays a logout: the refresh writes nothing and the host never gets its token", async () => {
    const release = Promise.withResolvers<void>()
    const endpoint = tokenEndpoint(release.promise)
    const result = await Effect.runPromise(Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const host = yield* hostWith(new Map())
      return yield* Effect.gen(function* () {
        const auth = yield* AuthStore
        const refreshing = yield* Effect.forkChild(auth.resolveKey(anthropic))
        yield* Effect.promise(() => endpoint.started)
        // The logout does not wait for the refresh in flight.
        yield* auth.remove(anthropic)
        release.resolve()
        const key = yield* Fiber.join(refreshing)
        return { key, stored: yield* auth.get(anthropic), all: yield* auth.all, saves: yield* Ref.get(host.saves) }
      }).pipe(Effect.provide(MemoryAuthStoreLive(new Map([[anthropic, expired(now)]]), { fetch: endpoint.fetch }).pipe(Layer.provide(host.layer))))
    }))
    expect(endpoint.requests.length).toBe(1)
    expect(Option.isNone(result.key)).toBe(true)
    expect(Option.isNone(result.stored)).toBe(true)
    expect(result.all.has(anthropic)).toBe(false)
    expect(result.saves).toEqual([[anthropic, Option.none()]])
  })

  test("a login during a stalled refresh wins over the refreshed token", async () => {
    const release = Promise.withResolvers<void>()
    const endpoint = tokenEndpoint(release.promise)
    const replacement: Credential = { type: "api_key", key: "replacement-key" }
    const result = await Effect.runPromise(Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      return yield* Effect.gen(function* () {
        const auth = yield* AuthStore
        const refreshing = yield* Effect.forkChild(auth.resolveKey(anthropic))
        yield* Effect.promise(() => endpoint.started)
        yield* auth.set(anthropic, replacement)
        release.resolve()
        return { key: Option.map(yield* Fiber.join(refreshing), Redacted.value), stored: yield* auth.get(anthropic) }
      }).pipe(Effect.provide(MemoryAuthStoreLive(new Map([[anthropic, expired(now)]]), { fetch: endpoint.fetch })))
    }))
    expect(result.key).toEqual(Option.some("replacement-key"))
    expect(Option.getOrThrow(result.stored)).toEqual(replacement)
  })

  test("a host that cannot save a refreshed token still gets the key: the token stays in memory", async () => {
    const endpoint = tokenEndpoint()
    const key = await Effect.runPromise(Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const host = yield* hostWith(new Map(), true)
      return yield* Effect.gen(function* () {
        const auth = yield* AuthStore
        const first = yield* auth.resolveKey(anthropic)
        yield* auth.resolveKey(anthropic)
        return Option.map(first, Redacted.value)
      }).pipe(Effect.provide(MemoryAuthStoreLive(new Map([[anthropic, expired(now)]]), { fetch: endpoint.fetch }).pipe(Layer.provide(host.layer))))
    }))
    expect(key).toEqual(Option.some("fresh-access-1"))
    expect(endpoint.requests.length).toBe(1)
  })

  test("a refresh the provider refuses fails with an AuthError and keeps the old credential", async () => {
    const refused = Object.assign(async () => new Response("invalid_grant", { status: 400 }), { preconnect: () => {} })
    const result = await Effect.runPromise(Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      return yield* Effect.gen(function* () {
        const auth = yield* AuthStore
        return { failure: yield* Effect.flip(auth.resolveKey(anthropic)), stored: yield* auth.get(anthropic) }
      }).pipe(Effect.provide(MemoryAuthStoreLive(new Map([[anthropic, expired(now)]]), { fetch: refused })))
    }))
    expect(result.failure).toMatchObject({ _tag: "AuthError", provider: "anthropic" })
    expect(Option.getOrThrow(result.stored)).toMatchObject({ access: "stale-access" })
  })
})

describe("MemoryAuthStoreLive and the host's credentials", () => {
  test("starts from the host's credentials overlaid by the seed, and hands each login and logout to the host", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* hostWith(new Map<string, CredentialInput>([
        ["opencode", { type: "api_key", key: Redacted.make("from-host") }],
        ["google", { type: "api_key", key: Redacted.make("google-from-host") }],
      ]))
      return yield* Effect.gen(function* () {
        const auth = yield* AuthStore
        const seeded = yield* auth.all
        yield* auth.set(ProviderId.make("openai"), { type: "api_key", key: "openai-login" })
        yield* auth.remove(ProviderId.make("google"))
        yield* auth.remove(ProviderId.make("never-signed-in"))
        return { seeded, saves: yield* Ref.get(host.saves) }
      }).pipe(Effect.provide(MemoryAuthStoreLive(new Map([[opencode, { type: "api_key", key: "from-seed" }]])).pipe(Layer.provide(host.layer))))
    }))
    expect(Object.fromEntries(result.seeded)).toEqual({ opencode: { type: "api_key", key: "from-seed" }, google: { type: "api_key", key: "google-from-host" } })
    expect(result.saves).toEqual([["openai", Option.some({ type: "api_key", key: "openai-login" })], ["google", Option.none()]])
  })

  test("a login or logout the host cannot save changes nothing in memory", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const host = yield* hostWith(new Map(), true)
      return yield* Effect.gen(function* () {
        const auth = yield* AuthStore
        const login = yield* Effect.flip(auth.set(ProviderId.make("openai"), { type: "api_key", key: "lost" }))
        const logout = yield* Effect.flip(auth.remove(opencode))
        return { login, logout, all: yield* auth.all }
      }).pipe(Effect.provide(MemoryAuthStoreLive(new Map([[opencode, { type: "api_key", key: "kept" }]])).pipe(Layer.provide(host.layer))))
    }))
    expect(result.login._tag).toBe("AuthError")
    expect(result.logout._tag).toBe("AuthError")
    expect(Object.fromEntries(result.all)).toEqual({ opencode: { type: "api_key", key: "kept" } })
  })
})

describe("the local store keeps its files", () => {
  test("the kit run leaves no credential and no temp file behind", async () => {
    const home = mkdtempSync(join(tmpdir(), "efferent-auth-kit-home-"))
    const cwd = mkdtempSync(join(tmpdir(), "efferent-auth-kit-cwd-"))
    const { store, options } = localKitSubject(cwd, home, anthropic)
    const left = await Effect.runPromise(Effect.forEach(authStoreConformance(store, options), (check) => Effect.result(check.run)).pipe(
      Effect.andThen(store.all),
      Effect.map((all) => ({ credentials: all.size, files: readdirSync(cwd), runtime: readdirSync(join(home, ".efferent", "runtime")) })),
      Effect.ensuring(Effect.sync(() => [home, cwd].map((dir) => rmSync(dir, { recursive: true, force: true })))),
    ))
    expect(left).toEqual({ credentials: 0, files: [], runtime: ["auth.json"] })
  })
})
