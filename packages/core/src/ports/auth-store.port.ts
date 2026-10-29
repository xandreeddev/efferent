import { Context, Option, Schema } from "effect"
import type { Effect, Redacted } from "effect"
import type { ProviderId } from "../domain/model-selection.entity.js"

/**
 * A stored provider credential: a raw API key, an OAuth subscription (with
 * refresh material and absolute expiry, epoch ms), or a local provider that
 * needs no key. Matches the on-disk `auth.json` vocabulary the previous line
 * established, so existing credentials keep working.
 */
export const Credential = Schema.Union(
  [Schema.Struct({ type: Schema.Literal("api_key"), key: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
    accountId: Schema.optional(Schema.String),
    installationId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("local"), baseUrl: Schema.optional(Schema.String) })],
)
export type Credential = typeof Credential.Type

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  provider: Schema.String,
  message: Schema.String,
  /**
   * `auth.corrupt`: the store's backing data could not be read or decoded.
   * Nothing was read as absent and nothing was written over it.
   */
  code: Schema.optionalKey(Schema.Literal("auth.corrupt")),
}) {}

/**
 * The credential store, read lazily per request: `resolveKey` returns a
 * usable secret (refreshing a near-expiry OAuth token first, and persisting
 * it where the store keeps credentials), so a credential added mid-session
 * takes effect on the next call with no restart. `None` means the provider
 * is not configured.
 *
 * One refresh of a credential runs at a time: concurrent calls on one
 * expired token send one token request and share its result. A `set` or
 * `remove` made while that request is in flight wins over the refreshed
 * token. A store whose backing data cannot be read or decoded fails every
 * call with an `AuthError` of code `auth.corrupt` instead of reading it as
 * empty, so no write replaces credentials it could not read.
 * `authStoreConformance` checks a store against this contract.
 */
export class AuthStore extends Context.Service<AuthStore, {
    readonly all: Effect.Effect<ReadonlyMap<string, Credential>, AuthError>
    readonly get: (p: ProviderId) => Effect.Effect<Option.Option<Credential>, AuthError>
    readonly resolveKey: (
      p: ProviderId,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, AuthError>
    /** Persist a credential (a login). */
    readonly set: (p: ProviderId, credential: Credential) => Effect.Effect<void, AuthError>
    /** Remove a provider's credential everywhere it is stored (a logout). */
    readonly remove: (p: ProviderId) => Effect.Effect<void, AuthError>
  }>()("@xandreed/core/AuthStore") {}
