import { describe, expect, test } from "bun:test"
import { Clock, Effect, Match, Option, Redacted, Ref } from "effect"
import { ProviderId } from "../domain/model-selection.entity.js"
import { AuthError, AuthStore } from "../ports/auth-store.port.js"
import type { Credential } from "../ports/auth-store.port.js"
import { authStoreConformance } from "./auth-store.conformance.js"

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

const failedChecks = (store: Store) => Effect.runPromise(Effect.forEach(authStoreConformance(store), (check) =>
  Effect.result(check.run).pipe(Effect.map((exit) => exit._tag === "Failure" ? [exit.failure.check] : []))).pipe(Effect.map((failed) => failed.flat().toSorted())))

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

describe("the AuthStore kit catches stores that break the contract", () => {
  test("a remove that keeps the credential fails the remove check", async () => {
    const store = Effect.runSync(reference)
    expect(await failedChecks(AuthStore.of({ ...store, remove: () => Effect.void }))).toEqual(["remove"])
  })

  test("a store that hands out an expired token fails the oauth-expired check", async () => {
    const store = Effect.runSync(reference)
    const stale = AuthStore.of({
      ...store,
      resolveKey: (provider) => store.get(provider).pipe(Effect.map(Option.flatMap((credential) =>
        credential.type === "oauth" ? Option.some(Redacted.make(credential.access)) : credential.type === "api_key" ? Option.some(Redacted.make(credential.key)) : Option.none()))),
    })
    expect(await failedChecks(stale)).toEqual(["oauth-expired"])
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
