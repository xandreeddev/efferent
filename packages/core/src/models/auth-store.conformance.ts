import { Clock, Effect, Fiber, Option, Redacted } from "effect"
import type { Context, Duration, Scope } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, fail } from "../conformance.functions.js"
import { ProviderId } from "../domain/model-selection.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import type { AuthStore, Credential } from "../ports/auth-store.port.js"
import { randomUuid } from "../util/random-id.js"

type Store = Context.Service.Shape<typeof AuthStore>

const HOUR = 3_600_000
/** How many calls the refresh check makes at once on one expired token. */
const CALLERS = 4
/** How long, on the live clock, the refresh checks wait for a store's first token request. */
const WAIT = "2 seconds"
/** How long a refresh check then gives the other calls to reach the store (the endpoint, a lock), before it answers. */
const SETTLE = "100 millis"

/**
 * The token endpoint a store refreshes through, as the kit sees it: the
 * test builds the store over a fetch (or an equivalent) that it controls,
 * and hands the kit this view of it.
 */
export interface AuthStoreRefreshProbe {
  /**
   * A provider whose expired OAuth token the store refreshes through this
   * endpoint (`anthropic`, `openai-codex`). The refresh checks write and
   * remove its credential, then put it back as they found it.
   */
  readonly provider: ProviderId
  /** The token requests the endpoint has received so far. */
  readonly requests: Effect.Effect<number>
  /**
   * Hold the endpoint: a request that arrives waits, unanswered, until the
   * returned effect runs. Running that effect again does nothing.
   */
  readonly hold: Effect.Effect<Effect.Effect<void>>
}

/** What the kit can do to a store beyond calling it; each option turns on its checks. */
export interface AuthStoreConformanceOptions {
  /** The endpoint the store refreshes through: the refresh-once and refresh-remove checks. */
  readonly refresh?: AuthStoreRefreshProbe
  /**
   * Damage the store's backing data (a file that is not JSON) for the
   * scope's lifetime, and repair it when the scope closes: the corrupt check.
   * A store with nothing to damage, such as one in memory, leaves it out.
   */
  readonly corrupt?: Effect.Effect<void, never, Scope.Scope>
}

/** A provider id no real store holds, so the kit can run against a shared store. */
const freshProvider = Effect.map(randomUuid, (id) => ProviderId.make(`conformance-${id}`))
/** A value no other check writes, so a read shows whose write it is. */
const secret = (label: string): Effect.Effect<string> => Effect.map(randomUuid, (id) => `conformance-${label}-${id}`)

const same = (a: Option.Option<Credential>, b: Credential): boolean => Option.isSome(a) && canonicalJson(a.value) === canonicalJson(b)

/** The key `resolveKey` gave, unwrapped; a key that is not `Redacted` fails `id`. */
const keyOf = (id: string, resolved: Option.Option<Redacted.Redacted<string>>) =>
  Option.match(resolved, {
    onNone: () => Effect.succeed(Option.none<string>()),
    onSome: (key) => Redacted.isRedacted(key) ? Effect.succeed(Option.some(Redacted.value(key))) : fail(id, "the resolved key is not Redacted"),
  })

/** Run `body` with `count` fresh providers, removing them afterwards so a shared store keeps nothing of the kit. */
const withProviders = (store: Store, count: number, body: (providers: ReadonlyArray<ProviderId>) => Effect.Effect<void, unknown>) =>
  Effect.forEach(Array.from({ length: count }), () => freshProvider).pipe(
    Effect.flatMap((providers) => body(providers).pipe(Effect.ensuring(Effect.forEach(providers, (provider) => store.remove(provider).pipe(Effect.ignore({ log: "Warn", message: `the kit could not remove its provider ${provider}` })), { discard: true })))),
  )

/** Run `body` on the probe's provider, then put back the credential it held before (or none). */
const withProbeProvider = (store: Store, probe: AuthStoreRefreshProbe, body: (provider: ProviderId) => Effect.Effect<void, unknown>) =>
  store.get(probe.provider).pipe(Effect.flatMap((before) => body(probe.provider).pipe(Effect.ensuring(Option.match(before, {
    onNone: () => store.remove(probe.provider),
    onSome: (credential) => store.set(probe.provider, credential),
  }).pipe(Effect.ignore({ log: "Warn", message: `the kit could not put back the credential of ${probe.provider}` }))))))

/** An OAuth credential that expired an hour ago, so any read of it needs a refresh. */
const expiredToken = Effect.gen(function* () {
  const now = yield* Clock.currentTimeMillis
  return { type: "oauth", access: yield* secret("stale"), refresh: yield* secret("refresh"), expires: now - HOUR } satisfies Credential
})

/** Wait, for at most `within` on the live clock, until the endpoint has received more than `floor` requests; how many it has then. */
const requestsAbove = (probe: AuthStoreRefreshProbe, floor: number, within: Duration.Input): Effect.Effect<number> => {
  const poll: Effect.Effect<number> = probe.requests.pipe(Effect.flatMap((count) => count > floor ? Effect.succeed(count)
    : Effect.sleep("2 millis").pipe(Effect.andThen(Effect.suspend(() => poll)))))
  return Effect.timeoutOption(poll, within).pipe(Effect.flatMap(Option.match({ onNone: () => probe.requests, onSome: Effect.succeed })))
}

/** `effect` must fail with an `AuthError` of code `auth.corrupt`. */
const corrupted = (what: string, effect: Effect.Effect<unknown, unknown>) => Effect.result(effect).pipe(Effect.flatMap((result) => {
  if (result._tag === "Success") return fail("corrupt", `${what} succeeded on a store whose backing data cannot be read`)
  const error: unknown = result.failure
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "an error"
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "no code"
  return expect("corrupt", tag === "AuthError" && code === "auth.corrupt", `${what} failed with ${tag} (${code}), not an AuthError of code auth.corrupt`)
}))

const refreshChecks = (store: Store, probe: AuthStoreRefreshProbe): ReadonlyArray<ConformanceCheck> => [
  check(`${CALLERS} concurrent calls on one expired OAuth token send one refresh request and all get its new token`, "refresh-once", () => withProbeProvider(store, probe, (provider) => Effect.gen(function* () {
    const stale = yield* expiredToken
    yield* store.set(provider, stale)
    const before = yield* probe.requests
    const keys = yield* Effect.acquireUseRelease(probe.hold, (release) => Effect.gen(function* () {
      const callers = yield* Effect.forEach(Array.from({ length: CALLERS }), () => Effect.forkChild(store.resolveKey(provider)))
      yield* expect("refresh-once", (yield* requestsAbove(probe, before, WAIT)) > before, `no refresh request reached the endpoint within ${WAIT}`)
      // Give every caller the time to reach the endpoint (or the store's lock) before the first answer.
      yield* requestsAbove(probe, before + 1, SETTLE)
      yield* release
      return yield* Fiber.joinAll(callers)
    }), (release) => release)
    const sent = (yield* probe.requests) - before
    yield* expect("refresh-once", sent === 1, `${CALLERS} concurrent calls on one expired token sent ${sent} refresh requests`)
    const values = yield* Effect.forEach(keys, (key) => keyOf("refresh-once", key))
    const first = Option.getOrUndefined(values[0] ?? Option.none())
    yield* expect("refresh-once", first !== undefined && first !== stale.access, "the first call did not get a new token")
    yield* expect("refresh-once", values.every((value) => Option.getOrUndefined(value) === first), "the concurrent calls got different keys")
    const stored = yield* store.get(provider)
    yield* expect("refresh-once", Option.exists(stored, (credential) => credential.type === "oauth" && credential.access === first), "the store does not hold the refreshed token")
  }))),
  check("a remove made while a refresh is in flight stays a remove: the refreshed token is not stored", "refresh-remove", () => withProbeProvider(store, probe, (provider) => Effect.gen(function* () {
    yield* store.set(provider, yield* expiredToken)
    const before = yield* probe.requests
    yield* Effect.acquireUseRelease(probe.hold, (release) => Effect.gen(function* () {
      const refreshing = yield* Effect.forkChild(store.resolveKey(provider))
      yield* expect("refresh-remove", (yield* requestsAbove(probe, before, WAIT)) > before, `no refresh request reached the endpoint within ${WAIT}`)
      const removing = yield* Effect.forkChild(store.remove(provider))
      // A store may make the remove wait for the refresh; the remove must stick either way.
      yield* Effect.timeoutOption(Fiber.await(removing), SETTLE)
      yield* release
      yield* Fiber.join(removing)
      // What the refreshing call returns is the store's choice; what it leaves stored is not.
      yield* Effect.result(Fiber.join(refreshing))
    }), (release) => release)
    yield* expect("refresh-remove", Option.isNone(yield* store.get(provider)), "get finds a credential after the remove")
    yield* expect("refresh-remove", !(yield* store.all).has(provider), "all lists the provider after the remove")
    yield* expect("refresh-remove", Option.isNone(yield* store.resolveKey(provider)), "resolveKey finds a key after the remove")
  }))),
]

const corruptCheck = (store: Store, corrupt: Effect.Effect<void, never, Scope.Scope>): ConformanceCheck =>
  check("a store whose backing data cannot be read fails every call with an AuthError of code auth.corrupt, never reads it as empty", "corrupt", () => withProviders(store, 2, ([provider, other]) => Effect.gen(function* () {
    const id = provider!
    const kept: Credential = { type: "api_key", key: yield* secret("kept") }
    yield* store.set(id, kept)
    yield* Effect.scoped(Effect.gen(function* () {
      yield* corrupt
      yield* corrupted("get", store.get(id))
      yield* corrupted("all", store.all)
      yield* corrupted("resolveKey", store.resolveKey(id))
      yield* corrupted("set", store.set(other!, { type: "api_key", key: yield* secret("other") }))
      yield* corrupted("remove", store.remove(id))
    }))
    yield* expect("corrupt", same(yield* store.get(id), kept), "once the backing data is repaired, the store does not read it again")
  })))

/**
 * The AuthStore contract, as checks any store must pass: what `get`, `all`
 * and `resolveKey` say about each kind of credential, what `set` and
 * `remove` change, and that providers do not share state. Every check uses
 * fresh provider ids (`conformance-<uuid>`, which no store can refresh) and
 * removes them when it ends, so the kit can run against a shared store.
 *
 * With `options.refresh`, two checks refresh the probe's provider through
 * the endpoint the test controls: concurrent calls on one expired token send
 * one token request, and a `remove` made while it is in flight sticks. They
 * wait for the store's requests on the live clock (up to two seconds), so
 * run them without a `TestClock`. With
 * `options.corrupt`, a store whose backing data cannot be read fails every
 * call with an `AuthError` of code `auth.corrupt` instead of reading empty.
 */
export const authStoreConformance = (store: Store, options: AuthStoreConformanceOptions = {}): ReadonlyArray<ConformanceCheck> => [
  check("an absent provider has no credential, no key and no entry", "absent", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    yield* expect("absent", Option.isNone(yield* store.get(id)), "get found a credential")
    yield* expect("absent", Option.isNone(yield* store.resolveKey(id)), "resolveKey found a key")
    yield* expect("absent", !(yield* store.all).has(id), "all lists the provider")
  }))),
  check("an api_key credential reads back, is listed, and resolves to its key as Redacted", "api-key", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    const credential: Credential = { type: "api_key", key: yield* secret("key") }
    yield* store.set(id, credential)
    yield* expect("api-key", same(yield* store.get(id), credential), "get returned a different credential")
    yield* expect("api-key", same(Option.fromNullishOr((yield* store.all).get(id)), credential), "all lists a different credential, or none")
    const key = yield* keyOf("api-key", yield* store.resolveKey(id))
    yield* expect("api-key", Option.getOrUndefined(key) === credential.key, "resolveKey did not return the stored key")
  }))),
  check("a local credential reads back and resolves to no key", "local", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    const credential: Credential = { type: "local", baseUrl: "http://127.0.0.1:1/v1" }
    yield* store.set(id, credential)
    yield* expect("local", same(yield* store.get(id), credential), "get returned a different credential")
    yield* expect("local", Option.isNone(yield* store.resolveKey(id)), "resolveKey returned a key for a local credential")
  }))),
  check("an OAuth token that has not expired resolves to its access token", "oauth-valid", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    const now = yield* Clock.currentTimeMillis
    const credential: Credential = { type: "oauth", access: yield* secret("access"), refresh: yield* secret("refresh"), expires: now + HOUR }
    yield* store.set(id, credential)
    yield* expect("oauth-valid", same(yield* store.get(id), credential), "get returned a different credential")
    const key = yield* keyOf("oauth-valid", yield* store.resolveKey(id))
    yield* expect("oauth-valid", Option.getOrUndefined(key) === credential.access, "resolveKey did not return the access token")
  }))),
  check("an expired OAuth token the store cannot refresh fails with an AuthError naming the provider, never the stale token", "oauth-expired", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    const now = yield* Clock.currentTimeMillis
    yield* store.set(id, { type: "oauth", access: yield* secret("stale"), refresh: yield* secret("refresh"), expires: now - HOUR })
    const resolved = yield* Effect.result(store.resolveKey(id))
    if (resolved._tag === "Success") return yield* fail("oauth-expired", Option.isSome(resolved.success) ? "resolveKey returned the expired token" : "resolveKey found no key instead of failing")
    yield* expect("oauth-expired", resolved.failure._tag === "AuthError" && resolved.failure.provider === id, `failed with ${resolved.failure._tag} for ${resolved.failure.provider}`)
  }))),
  check("a second set replaces the first", "overwrite", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    const second: Credential = { type: "api_key", key: yield* secret("second") }
    yield* store.set(id, { type: "api_key", key: yield* secret("first") })
    yield* store.set(id, second)
    yield* expect("overwrite", same(yield* store.get(id), second), "get still returns the first credential")
    const key = yield* keyOf("overwrite", yield* store.resolveKey(id))
    yield* expect("overwrite", Option.getOrUndefined(key) === second.key, "resolveKey still returns the first key")
  }))),
  check("remove deletes a credential wherever it is read, and removing an absent provider succeeds", "remove", () => withProviders(store, 2, ([provider, unknown]) => Effect.gen(function* () {
    const id = provider!
    yield* store.set(id, { type: "api_key", key: yield* secret("removed") })
    yield* store.remove(id)
    yield* expect("remove", Option.isNone(yield* store.get(id)), "get still finds the credential")
    yield* expect("remove", Option.isNone(yield* store.resolveKey(id)), "resolveKey still finds a key")
    yield* expect("remove", !(yield* store.all).has(id), "all still lists the provider")
    yield* store.remove(id)
    yield* store.remove(unknown!)
  }))),
  check("providers are isolated: writing or removing one leaves another as it was", "isolation", () => withProviders(store, 2, ([first, second]) => Effect.gen(function* () {
    const a = first!
    const b = second!
    const kept: Credential = { type: "api_key", key: yield* secret("kept") }
    yield* store.set(b, kept)
    yield* store.set(a, { type: "api_key", key: yield* secret("other") })
    yield* store.remove(a)
    yield* store.set(a, { type: "local" })
    yield* expect("isolation", same(yield* store.get(b), kept), "another provider's credential changed")
    const key = yield* keyOf("isolation", yield* store.resolveKey(b))
    yield* expect("isolation", Option.getOrUndefined(key) === kept.key, "another provider's key changed")
  }))),
  ...Option.match(Option.fromNullishOr(options.refresh), { onNone: () => [], onSome: (probe) => refreshChecks(store, probe) }),
  ...Option.match(Option.fromNullishOr(options.corrupt), { onNone: () => [], onSome: (corrupt) => [corruptCheck(store, corrupt)] }),
]
