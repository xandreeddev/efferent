import { Clock, Effect, Equal, Match, Option, Schema } from "effect"
import type { Redacted, Semaphore } from "effect"
import { AuthError } from "../ports/auth-store.port.js"
import type { ProviderId } from "@xandreed/core"
import type { Credential } from "../ports/auth-store.port.js"
import { refreshAnthropicToken } from "./anthropicOAuth.js"
import type { TokenRequestOptions } from "./anthropicOAuth.js"
import { RefreshableProvider } from "./credential-refresh.entity.js"
import type { OAuthCredential } from "./credential-refresh.entity.js"
import { refreshOpenAiCodexToken } from "./openAiCodexOAuth.js"

/** Refresh this many ms before the recorded expiry. */
export const REFRESH_SKEW_MS = 60_000

/** Whether an OAuth credential can still be used at `now`: more than the skew before its expiry. */
export const isUsableAt = (credential: OAuthCredential, now: number): boolean => credential.expires > now + REFRESH_SKEW_MS

/**
 * Refresh one provider's OAuth credential through that provider's token
 * endpoint: the same credential with the new access token, refresh token
 * and expiry (and account id, where the provider sends one), its tokens
 * `Redacted`. A provider with no refresh flow fails with an `AuthError`
 * naming it.
 */
export const refreshCredential = (
  provider: string,
  credential: OAuthCredential,
  options: TokenRequestOptions = {},
): Effect.Effect<OAuthCredential, AuthError> =>
  Option.match(Schema.decodeUnknownOption(RefreshableProvider)(provider), {
    onNone: () => Effect.fail(new AuthError({
      provider,
      message: `the ${provider} OAuth token expired and only anthropic and openai-codex tokens can be refreshed — sign in again or use an API key`,
    })),
    onSome: (refreshable) => Match.value(refreshable).pipe(
      Match.when("anthropic", () => refreshAnthropicToken(credential.refresh, options)),
      Match.when("openai-codex", () => refreshOpenAiCodexToken(credential.refresh, options)),
      Match.exhaustive,
    ).pipe(Effect.map((fresh): OAuthCredential => ({ ...credential, ...fresh }))),
  })

/** Whether `held` is still the token `stale` is: the same access token, refresh token and expiry. */
export const isSameToken = (held: Credential, stale: OAuthCredential): boolean =>
  held.type === "oauth" && Equal.equals(held.access, stale.access) && Equal.equals(held.refresh, stale.refresh) && held.expires === stale.expires

/** One provider's credential as a store keeps it, seen by the refresh. */
export interface CredentialSlot {
  /** The credential the store holds now, read again on every call. */
  readonly current: Effect.Effect<Option.Option<Credential>, AuthError>
  /**
   * Store `fresh` only if the provider still holds `stale` (`isSameToken`),
   * atomically with the store's other writes; whether it was stored.
   */
  readonly commit: (stale: OAuthCredential, fresh: OAuthCredential) => Effect.Effect<boolean, AuthError>
  /** Held while a refresh runs, so one refresh of the credential runs at a time. */
  readonly refreshLock: Effect.Effect<Semaphore.Semaphore>
}

/**
 * The key a slot's credential resolves to: an API key as it is, a usable
 * OAuth access token, or the token a refresh gives a near-expiry one. A
 * `local` credential, or none, has no key.
 *
 * One refresh runs at a time. Once the lock is held, a credential that is no
 * longer the expired one (refreshed by the call ahead, replaced or removed)
 * is resolved again instead, so concurrent calls send one token request. A
 * refresh stores its token only if the credential is still the one it
 * refreshed: a login or logout made meanwhile wins. The token request and
 * its commit run uninterrupted, since a provider that rotated the refresh
 * token has already spent the old one.
 */
export const resolveSlotKey = (
  provider: ProviderId,
  slot: CredentialSlot,
  tokens: TokenRequestOptions,
): Effect.Effect<Option.Option<Redacted.Redacted<string>>, AuthError> => {
  const refreshing = (stale: OAuthCredential): Effect.Effect<Option.Option<Redacted.Redacted<string>>, AuthError> =>
    slot.refreshLock.pipe(
      Effect.flatMap((lock) => lock.withPermit(slot.current.pipe(Effect.flatMap((before) =>
        Option.exists(before, (held) => isSameToken(held, stale))
          ? Effect.uninterruptible(refreshCredential(provider, stale, tokens).pipe(
            Effect.flatMap((fresh) => slot.commit(stale, fresh).pipe(Effect.map((stored) => stored ? Option.some(fresh.access) : Option.none()))),
          ))
          : Effect.succeedNone)))),
      Effect.flatMap(Option.match({
        onSome: (access) => Effect.succeedSome(access),
        // The credential changed meanwhile: resolve what the store holds now.
        onNone: () => resolveSlotKey(provider, slot, tokens),
      })),
    )
  return slot.current.pipe(Effect.flatMap(Option.match({
    onNone: () => Effect.succeedNone,
    onSome: (credential) => Match.value(credential).pipe(
      Match.when({ type: "api_key" }, ({ key }) => Effect.succeedSome(key)),
      Match.when({ type: "local" }, () => Effect.succeedNone),
      Match.when({ type: "oauth" }, (oauth) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
        isUsableAt(oauth, now) ? Effect.succeedSome(oauth.access) : refreshing(oauth)))),
      Match.exhaustive,
    ),
  })))
}
