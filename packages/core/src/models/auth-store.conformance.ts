import { Clock, Effect, Option, Redacted } from "effect"
import type { Context } from "effect"
import type { ConformanceCheck } from "../conformance.entity.js"
import { check, expect, fail } from "../conformance.functions.js"
import { ProviderId } from "../domain/model-selection.entity.js"
import { canonicalJson } from "../memory/memory-log.entity.functions.js"
import type { AuthStore, Credential } from "../ports/auth-store.port.js"

type Store = Context.Service.Shape<typeof AuthStore>

const HOUR = 3_600_000

/** A provider id no real store holds, so the kit can run against a shared store. */
const freshProvider = Effect.sync(() => ProviderId.make(`conformance-${crypto.randomUUID()}`))
const secret = (label: string) => `conformance-${label}-${crypto.randomUUID()}`

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
    Effect.flatMap((providers) => body(providers).pipe(Effect.ensuring(Effect.forEach(providers, (provider) => store.remove(provider).pipe(Effect.ignore), { discard: true })))),
  )

/**
 * The AuthStore contract, as checks any store must pass: what `get`, `all`
 * and `resolveKey` say about each kind of credential, what `set` and
 * `remove` change, and that providers do not share state. Every check uses
 * fresh provider ids (`conformance-<uuid>`, which no store can refresh) and
 * removes them when it ends, so the kit can run against a shared store.
 */
export const authStoreConformance = (store: Store): ReadonlyArray<ConformanceCheck> => [
  check("an absent provider has no credential, no key and no entry", "absent", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    yield* expect("absent", Option.isNone(yield* store.get(id)), "get found a credential")
    yield* expect("absent", Option.isNone(yield* store.resolveKey(id)), "resolveKey found a key")
    yield* expect("absent", !(yield* store.all).has(id), "all lists the provider")
  }))),
  check("an api_key credential reads back, is listed, and resolves to its key as Redacted", "api-key", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    const credential: Credential = { type: "api_key", key: secret("key") }
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
    const credential: Credential = { type: "oauth", access: secret("access"), refresh: secret("refresh"), expires: now + HOUR }
    yield* store.set(id, credential)
    yield* expect("oauth-valid", same(yield* store.get(id), credential), "get returned a different credential")
    const key = yield* keyOf("oauth-valid", yield* store.resolveKey(id))
    yield* expect("oauth-valid", Option.getOrUndefined(key) === credential.access, "resolveKey did not return the access token")
  }))),
  check("an expired OAuth token the store cannot refresh fails with an AuthError naming the provider, never the stale token", "oauth-expired", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    const now = yield* Clock.currentTimeMillis
    yield* store.set(id, { type: "oauth", access: secret("stale"), refresh: secret("refresh"), expires: now - HOUR })
    const resolved = yield* Effect.result(store.resolveKey(id))
    if (resolved._tag === "Success") return yield* fail("oauth-expired", Option.isSome(resolved.success) ? "resolveKey returned the expired token" : "resolveKey found no key instead of failing")
    yield* expect("oauth-expired", resolved.failure._tag === "AuthError" && resolved.failure.provider === id, `failed with ${resolved.failure._tag} for ${resolved.failure.provider}`)
  }))),
  check("a second set replaces the first", "overwrite", () => withProviders(store, 1, ([provider]) => Effect.gen(function* () {
    const id = provider!
    const second: Credential = { type: "api_key", key: secret("second") }
    yield* store.set(id, { type: "api_key", key: secret("first") })
    yield* store.set(id, second)
    yield* expect("overwrite", same(yield* store.get(id), second), "get still returns the first credential")
    const key = yield* keyOf("overwrite", yield* store.resolveKey(id))
    yield* expect("overwrite", Option.getOrUndefined(key) === second.key, "resolveKey still returns the first key")
  }))),
  check("remove deletes a credential wherever it is read, and removing an absent provider succeeds", "remove", () => withProviders(store, 2, ([provider, unknown]) => Effect.gen(function* () {
    const id = provider!
    yield* store.set(id, { type: "api_key", key: secret("removed") })
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
    const kept: Credential = { type: "api_key", key: secret("kept") }
    yield* store.set(b, kept)
    yield* store.set(a, { type: "api_key", key: secret("other") })
    yield* store.remove(a)
    yield* store.set(a, { type: "local" })
    yield* expect("isolation", same(yield* store.get(b), kept), "another provider's credential changed")
    const key = yield* keyOf("isolation", yield* store.resolveKey(b))
    yield* expect("isolation", Option.getOrUndefined(key) === kept.key, "another provider's key changed")
  }))),
]
