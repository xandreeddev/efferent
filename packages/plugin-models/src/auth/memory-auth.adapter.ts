import { Clock, Effect, Layer, Match, Option, Redacted, Ref, Semaphore, SynchronizedRef } from "effect"
import { AuthStore } from "@xandreed/core"
import type { AuthError, Credential, ProviderId } from "@xandreed/core"
import { HostCredentials } from "../ports/host-credentials.port.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
import type { ModelsFetch } from "../ports/models-transport.port.js"
import { toCredential, toCredentialInput } from "./credential-input.entity.functions.js"
import { isUsableAt, refreshCredential } from "./credential-refresh.entity.functions.js"
import type { TokenRequestOptions } from "./anthropicOAuth.js"
import type { OAuthCredential } from "./credential-refresh.entity.js"

/** How the in-memory store reaches the OAuth token endpoints. */
export interface MemoryAuthOptions {
  /** The fetch token refreshes go through; default: the `ModelsTransport`'s when the layer is built over one, else the global fetch. */
  readonly fetch?: ModelsFetch
}

/** Each provider's two locks: `commit` orders set, remove and a refresh's write; `refresh` lets one refresh run at a time. */
interface ProviderLocks {
  readonly commit: Semaphore.Semaphore
  readonly refresh: Semaphore.Semaphore
}

/** What a refresh found once it held its lock: a key to return, or a credential that changed meanwhile. */
type Refreshed = { readonly _tag: "Key"; readonly key: Redacted.Redacted<string> } | { readonly _tag: "Changed" }

/**
 * `MemoryAuthStoreLive(seed?)` — an AuthStore that never touches disk.
 * Credentials live in memory for the layer's lifetime: the host's
 * `HostCredentials.load` (when the host provides that service), overlaid by
 * `seed`. `resolveKey` refreshes a near-expiry anthropic or openai-codex
 * OAuth token in memory, one refresh per provider at a time (through the
 * `ModelsTransport` it was built over, so through the plugin's proxy), and
 * hands the new token to `HostCredentials.save`.
 *
 * A login or logout (`set`, `remove`) does not wait for a refresh's token
 * request; it waits only while a refreshed token is committed, which
 * includes the host's `save` of it, so a slow host store delays it that
 * long. A refresh writes its token only if the provider still holds the
 * credential it refreshed (compare-and-set under the provider's lock): a
 * logout during a stalled token request stays a logout, and the host never
 * receives the refreshed token.
 */
export const MemoryAuthStoreLive = (
  seed: ReadonlyMap<string, Credential> = new Map(),
  options: MemoryAuthOptions = {},
): Layer.Layer<AuthStore, AuthError> =>
  Layer.effect(AuthStore, Effect.gen(function* () {
    const host = yield* Effect.serviceOption(HostCredentials)
    const loaded = yield* Option.match(host, {
      onNone: () => Effect.succeed<ReadonlyMap<string, Credential>>(new Map()),
      onSome: (credentials) => credentials.load.pipe(Effect.map((all) => new Map([...all].map(([provider, input]) => [provider, toCredential(input)] as const)))),
    })
    const state = yield* Ref.make<ReadonlyMap<string, Credential>>(new Map([...loaded, ...seed]))
    const locks = yield* SynchronizedRef.make<ReadonlyMap<string, ProviderLocks>>(new Map())
    const transport = yield* Effect.serviceOption(ModelsTransport)
    const tokens: TokenRequestOptions = Option.match(Option.orElse(Option.fromNullishOr(options.fetch), () => Option.map(transport, (found) => found.fetch)), {
      onNone: () => ({}),
      onSome: (fetch) => ({ fetch }),
    })

    const locksOf = (provider: ProviderId) => SynchronizedRef.modifyEffect(locks, (all) => Option.match(Option.fromNullishOr(all.get(provider)), {
      onSome: (found) => Effect.succeed([found, all] as const),
      onNone: () => Effect.all({ commit: Semaphore.make(1), refresh: Semaphore.make(1) }).pipe(
        Effect.map((made) => [made, new Map([...all, [provider, made]])] as const),
      ),
    }))
    const current = (provider: ProviderId): Effect.Effect<Option.Option<Credential>> => Ref.get(state).pipe(Effect.map((all) => Option.fromNullishOr(all.get(provider))))
    const save = (provider: ProviderId, credential: Option.Option<Credential>): Effect.Effect<void, AuthError> => Option.match(host, {
      onNone: () => Effect.void,
      onSome: (credentials) => credentials.save(provider, Option.map(credential, toCredentialInput)),
    })
    const write = (provider: ProviderId, credential: Option.Option<Credential>): Effect.Effect<void> => Ref.update(state, (all) => Option.match(credential, {
      onNone: () => new Map([...all].filter(([key]) => key !== provider)),
      onSome: (value) => new Map([...all, [provider, value]]),
    }))

    /**
     * Refresh `stale` under the provider's refresh lock. Once the lock is
     * held, a credential that is no longer `stale` (refreshed by the call
     * ahead of this one, replaced or removed) is resolved again instead.
     */
    const refreshing = (provider: ProviderId, stale: OAuthCredential): Effect.Effect<Option.Option<Redacted.Redacted<string>>, AuthError> =>
      locksOf(provider).pipe(
        Effect.flatMap((lock) => lock.refresh.withPermit(Effect.gen(function* () {
          const before = yield* current(provider)
          if (!Option.exists(before, (held) => held === stale)) return { _tag: "Changed" } satisfies Refreshed
          const fresh = yield* refreshCredential(provider, stale, tokens)
          // The token rotated at the provider: memory keeps it even when the host cannot.
          return yield* lock.commit.withPermit(Effect.gen(function* () {
            const now = yield* current(provider)
            if (!Option.exists(now, (held) => held === stale)) return { _tag: "Changed" } satisfies Refreshed
            yield* write(provider, Option.some(fresh))
            yield* save(provider, Option.some(fresh)).pipe(
              Effect.catch((error) => Effect.logWarning(`the refreshed ${provider} token is kept in memory, but the host did not save it: ${error.message}`)),
            )
            return { _tag: "Key", key: Redacted.make(fresh.access) } satisfies Refreshed
          }))
        }))),
        Effect.flatMap((refreshed: Refreshed) => Match.value(refreshed).pipe(
          Match.tag("Key", ({ key }) => Effect.succeed(Option.some(key))),
          Match.tag("Changed", () => resolveKey(provider)),
          Match.exhaustive,
        )),
      )

    const resolveKey = (provider: ProviderId): Effect.Effect<Option.Option<Redacted.Redacted<string>>, AuthError> =>
      current(provider).pipe(Effect.flatMap(Option.match({
        onNone: () => Effect.succeed(Option.none<Redacted.Redacted<string>>()),
        onSome: (credential) => Match.value(credential).pipe(
          Match.when({ type: "api_key" }, ({ key }) => Effect.succeed(Option.some(Redacted.make(key)))),
          Match.when({ type: "local" }, () => Effect.succeed(Option.none<Redacted.Redacted<string>>())),
          Match.when({ type: "oauth" }, (oauth) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
            isUsableAt(oauth, now) ? Effect.succeed(Option.some(Redacted.make(oauth.access))) : refreshing(provider, oauth)))),
          Match.exhaustive,
        ),
      })))

    return AuthStore.of({
      all: Ref.get(state),
      get: current,
      resolveKey,
      // The host saves first: a login or logout it could not keep changes nothing.
      set: (provider, credential) => locksOf(provider).pipe(Effect.flatMap((lock) => lock.commit.withPermit(
        save(provider, Option.some(credential)).pipe(Effect.andThen(write(provider, Option.some(credential)))),
      ))),
      remove: (provider) => locksOf(provider).pipe(Effect.flatMap((lock) => lock.commit.withPermit(
        current(provider).pipe(Effect.flatMap((held) => Option.isNone(held) ? Effect.void
          : save(provider, Option.none()).pipe(Effect.andThen(write(provider, Option.none()))))),
      ))),
    })
  }))
