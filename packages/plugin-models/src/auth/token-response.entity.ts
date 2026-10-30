import { Schema } from "effect"

/**
 * A token endpoint's answer, as both subscription providers send it: the
 * access token, its lifetime in seconds, and a refresh token. A refresh may
 * leave the refresh token out, when the provider does not rotate it. The
 * tokens decode `Redacted`, so from the response on they print as
 * `<redacted>` in errors, logs and fingerprints.
 */
export const TokenResponse = Schema.Struct({
  access_token: Schema.RedactedFromValue(Schema.NonEmptyString),
  expires_in: Schema.Finite.check(Schema.isGreaterThan(0)),
  refresh_token: Schema.OptionFromOptional(Schema.RedactedFromValue(Schema.String)),
})
export type TokenResponse = typeof TokenResponse.Type

/** The tokens a response grants, `Redacted`: the access token, the refresh token to keep, and the access token's lifetime in ms. */
export const IssuedTokens = Schema.Struct({
  access: Schema.Redacted(Schema.String),
  refresh: Schema.Redacted(Schema.String),
  lifetimeMs: Schema.Number,
})
export type IssuedTokens = typeof IssuedTokens.Type
