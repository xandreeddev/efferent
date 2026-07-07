import { Context, Option, Schema } from "effect"
import type { Effect, Redacted } from "effect"
import type { ProviderId } from "../domain/ModelSelection.js"

/**
 * A stored provider credential: a raw API key, an OAuth subscription (with
 * refresh material and absolute expiry, epoch ms), or a local provider that
 * needs no key. Matches the on-disk `auth.json` vocabulary the previous line
 * established, so existing credentials keep working.
 */
export const Credential = Schema.Union(
  Schema.Struct({ type: Schema.Literal("api_key"), key: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    access: Schema.String,
    refresh: Schema.String,
    expires: Schema.Number,
    accountId: Schema.optional(Schema.String),
    installationId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("local"), baseUrl: Schema.optional(Schema.String) }),
)
export type Credential = typeof Credential.Type

export class AuthError extends Schema.TaggedError<AuthError>()("AuthError", {
  provider: Schema.String,
  message: Schema.String,
}) {}

/**
 * The credential store, read lazily per request: `resolveKey` returns a
 * usable secret (refreshing + persisting a near-expiry OAuth token first),
 * so a credential added mid-session takes effect on the next call with no
 * restart. `None` means the provider is not configured.
 */
export class AuthStore extends Context.Tag("@xandreed/engine/AuthStore")<
  AuthStore,
  {
    readonly all: Effect.Effect<ReadonlyMap<string, Credential>, AuthError>
    readonly get: (p: ProviderId) => Effect.Effect<Option.Option<Credential>, AuthError>
    readonly resolveKey: (
      p: ProviderId,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, AuthError>
  }
>() {}
