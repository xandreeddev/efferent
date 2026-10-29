import { describe, expect, test } from "bun:test"
import { Clock, Deferred, Effect, Match, Option, Redacted, Ref, Semaphore } from "effect"
import { ProviderId } from "../domain/model-selection.entity.js"
import { AuthError, AuthStore } from "../ports/auth-store.port.js"
import type { Credential } from "../ports/auth-store.port.js"
import { authStoreConformance } from "./auth-store.conformance.js"
import type { AuthStoreConformanceOptions, AuthStoreRefreshProbe } from "./auth-store.conformance.js"

type Store = typeof AuthStore.Service

/** A minimal store that keeps the contract: credentials in a Ref, no refresh flow. */
const reference = Effect.gen(function* () {
  const state = yield* Ref.make<ReadonlyMap<string, Credential>>(new Map())
  return AuthStore.of({
    all: Ref.get(state),
    get: (provider) => Ref.get(state).pipe(Effect.map((all) => Option.fromNullishOr(all.get(provider)))),
    resolveKey: (provider) => Effect.gen(function* () {
      const credential = Option.fromNullishOr((yield* Ref.get(state)).get(provider))
      if (Option.isNone(credential)) return Option.none()
      const now = yield* Clock.currentTimeMillis
      return yield* Match.value(credential.value).pipe(
        Match.when({ type: "api_key" }, (value) => Effect.succeed(Option.some(Redacted.make(value.key)))),
        Match.when({ type: "local" }, () => Effect.succeed(Option.none<Redacted.Redacted<string>>())),
        Match.when({ type: "oauth" }, (value) => value.expires > now + 60_000
          ? Effect.succeed(Option.some(Redacted.make(value.access)))
          : Effect.fail(new AuthError({ provider, message: "the token expired" }))),
        Match.exhaustive,
      )
    }),
    set: (provider, credential) => Ref.update(state, (all) => new Map([...all, [provider, credential]])),
    remove: (provider) => Ref.update(state, (all) => new Map([...all].filter(([key]) => key !== provider))),
  })
})

const failedChecks = (store: Store, options: AuthStoreConformanceOptions = {}) => Effect.runPromise(Effect.forEach(authStoreConformance(store, options), (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : []))).pipe(Effect.map((failed) => failed.flat().toSorted())))

/** A token endpoint in Effect: it counts requests and, while held, keeps each one waiting. */
const endpoint = (provider: ProviderId) => Effect.gen(function* () {
  const requests = yield* Ref.make(0)
  const gate = yield* Ref.make(Option.none<Deferred.Deferred<void>>())
  const call = Ref.updateAndGet(requests, (count) => count + 1).pipe(
    Effect.tap(() => Ref.get(gate).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Deferred.await })))),
  )
  const probe: AuthStoreRefreshProbe = {
    provider,
    requests: Ref.get(requests),
    hold: Deferred.make<void>().pipe(
      Effect.tap((held) => Ref.set(gate, Option.some(held))),
      Effect.map((held) => Ref.set(gate, Option.none()).pipe(Effect.andThen(Deferred.succeed(held, undefined)), Effect.asVoid)),
    ),
  }
  return { call, probe }
})

/**
 * A store with a refresh flow for one provider and backing data the kit can
 * damage. `locked`: one refresh at a time, and a call that finds the token
 * already replaced resolves again. `checked`: a refresh stores its token only
 * over the one it refreshed. `damaged`: what the store does while its data is
 * damaged, fail with `auth.corrupt` or read it as empty.
 */
const refreshingReference = (behaviour: { readonly locked: boolean; readonly checked: boolean; readonly damaged: "fail" | "empty" }) => Effect.gen(function* () {
  const state = yield* Ref.make<ReadonlyMap<string, Credential>>(new Map())
  const damaged = yield* Ref.make(false)
  const lock = yield* Semaphore.make(1)
  const { call, probe } = yield* endpoint(ProviderId.make("refreshable"))
  const readable = <A>(effect: Effect.Effect<A, AuthError>, empty: A): Effect.Effect<A, AuthError> => Ref.get(damaged).pipe(Effect.flatMap((isDamaged) =>
    !isDamaged ? effect
      : behaviour.damaged === "fail" ? Effect.fail(new AuthError({ provider: "*", code: "auth.corrupt", message: "the data is damaged" }))
      : Effect.succeed(empty)))
  const current = (provider: ProviderId) => Ref.get(state).pipe(Effect.map((all) => Option.fromNullishOr(all.get(provider))))
  const write = (provider: ProviderId, credential: Option.Option<Credential>) => Ref.update(state, (all) => Option.match(credential, {
    onNone: () => new Map([...all].filter(([key]) => key !== provider)),
    onSome: (value) => new Map([...all, [provider, value]]),
  }))
  const refresh = (provider: ProviderId, stale: Extract<Credential, { readonly type: "oauth" }>): Effect.Effect<Option.Option<Redacted.Redacted<string>>, AuthError> => {
    const once = Effect.gen(function* () {
      if (behaviour.locked && !Option.exists(yield* current(provider), (held) => held === stale)) return Option.none<string>()
      const count = yield* call
      const fresh: Credential = { ...stale, access: `fresh-access-${count}`, expires: (yield* Clock.currentTimeMillis) + 3_600_000 }
      if (behaviour.checked && !Option.exists(yield* current(provider), (held) => held === stale)) return Option.none<string>()
      yield* write(provider, Option.some(fresh))
      return Option.some(fresh.access)
    })
    return (behaviour.locked ? lock.withPermit(once) : once).pipe(Effect.flatMap(Option.match({
      onSome: (access) => Effect.succeed(Option.some(Redacted.make(access))),
      onNone: () => resolveKey(provider),
    })))
  }
  const resolveKey = (provider: ProviderId): Effect.Effect<Option.Option<Redacted.Redacted<string>>, AuthError> => current(provider).pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.succeed(Option.none<Redacted.Redacted<string>>()),
    onSome: (credential) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => Match.value(credential).pipe(
      Match.when({ type: "api_key" }, (value) => Effect.succeed(Option.some(Redacted.make(value.key)))),
      Match.when({ type: "local" }, () => Effect.succeed(Option.none<Redacted.Redacted<string>>())),
      Match.when({ type: "oauth" }, (value) => value.expires > now + 60_000 ? Effect.succeed(Option.some(Redacted.make(value.access)))
        : provider === probe.provider ? refresh(provider, value)
        : Effect.fail(new AuthError({ provider, message: "the token expired" }))),
      Match.exhaustive,
    ))),
  })))
  const store = AuthStore.of({
    all: readable(Ref.get(state), new Map()),
    get: (provider) => readable(current(provider), Option.none()),
    resolveKey: (provider) => readable(resolveKey(provider), Option.none()),
    set: (provider, credential) => readable(write(provider, Option.some(credential)), undefined),
    remove: (provider) => readable(write(provider, Option.none()), undefined),
  })
  const corrupt = Effect.acquireRelease(Ref.set(damaged, true), () => Ref.set(damaged, false))
  return { store, options: { refresh: probe, corrupt } satisfies AuthStoreConformanceOptions }
})

describe("the AuthStore kit", () => {
  const store = Effect.runSync(reference)
  authStoreConformance(store).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))

  test("leaves a shared store as it found it", async () => {
    await failedChecks(store)
    expect((await Effect.runPromise(store.all)).size).toBe(0)
  })
})

describe("the AuthStore kit over a store with a refresh flow and backing data", () => {
  const { store, options } = Effect.runSync(refreshingReference({ locked: true, checked: true, damaged: "fail" }))
  authStoreConformance(store, options).map((check) => test(check.name, async () => {
    const exit = await Effect.runPromise(Effect.result(check.run))
    expect(exit._tag === "Failure" ? exit.failure.message : "ok").toBe("ok")
  }))

  test("puts back the probe's provider as it found it, and sends one request per refresh check", async () => {
    const before: Credential = { type: "api_key", key: "the host's own" }
    await Effect.runPromise(store.set(options.refresh.provider, before))
    const sent = await Effect.runPromise(options.refresh.requests)
    expect(await failedChecks(store, options)).toEqual([])
    expect(Option.getOrThrow(await Effect.runPromise(store.get(options.refresh.provider)))).toEqual(before)
    expect(await Effect.runPromise(options.refresh.requests)).toBe(sent + 2)
  })
})

describe("the AuthStore kit catches stores that break the contract", () => {
  test("a remove that keeps the credential fails the remove check", async () => {
    const store = Effect.runSync(reference)
    expect(await failedChecks(AuthStore.of({ ...store, remove: () => Effect.void }))).toEqual(["remove"])
  })

  test("a store that hands out an expired token fails the oauth-expired check", async () => {
    const store = Effect.runSync(reference)
    const stale = AuthStore.of({
      ...store,
      resolveKey: (provider) => store.get(provider).pipe(Effect.map(Option.flatMap((credential) => Match.value(credential).pipe(
        Match.discriminatorsExhaustive("type")({
          oauth: (oauth) => Option.some(Redacted.make(oauth.access)),
          api_key: (apiKey) => Option.some(Redacted.make(apiKey.key)),
          local: () => Option.none(),
        }),
      )))),
    })
    expect(await failedChecks(stale)).toEqual(["oauth-expired"])
  })

  test("a store that refreshes without a lock fails the refresh-once check", async () => {
    const { store, options } = Effect.runSync(refreshingReference({ locked: false, checked: true, damaged: "fail" }))
    expect(await failedChecks(store, options)).toEqual(["refresh-once"])
  })

  test("a store whose refresh writes over a logout fails the refresh-remove check", async () => {
    const { store, options } = Effect.runSync(refreshingReference({ locked: true, checked: false, damaged: "fail" }))
    expect(await failedChecks(store, options)).toEqual(["refresh-remove"])
  })

  test("a store that reads damaged data as empty fails the corrupt check", async () => {
    const { store, options } = Effect.runSync(refreshingReference({ locked: true, checked: true, damaged: "empty" }))
    expect(await failedChecks(store, options)).toEqual(["corrupt"])
  })

  test("a store whose providers share one slot fails the isolation check", async () => {
    const store = Effect.runSync(reference)
    const shared = ProviderId.make("shared")
    const oneSlot = AuthStore.of({
      ...store,
      get: () => store.get(shared),
      resolveKey: () => store.resolveKey(shared),
      set: (_provider, credential) => store.set(shared, credential),
    })
    expect(await failedChecks(oneSlot)).toContain("isolation")
  })
})
