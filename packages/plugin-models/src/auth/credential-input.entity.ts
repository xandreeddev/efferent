import { Schema } from "effect"

/**
 * A credential as a host hands it over: in plugin options (`credentials`)
 * or through `HostCredentials`. Its secrets are `Redacted`, so they print
 * as `<redacted>` in errors, logs and graph fingerprints. A plain string
 * where a secret belongs is refused, and the refusal never repeats it.
 */
const secret = Schema.Redacted(Schema.String).annotate({
  message: "a secret must be a Redacted value (Redacted.make(...)); JSON configuration names an environment variable in credentialEnv instead",
})

/**
 * The provider account an OAuth credential is for (the ChatGPT account of an `openai-codex` subscription).
 *
 * @public
 */
export const AccountId = Schema.String.pipe(Schema.brand("AccountId"))
export type AccountId = typeof AccountId.Type

/**
 * The installation an OAuth credential was issued to, when its provider names one.
 *
 * @public
 */
export const InstallationId = Schema.String.pipe(Schema.brand("InstallationId"))
export type InstallationId = typeof InstallationId.Type

// An unknown key is named, never its value: a misspelt `key` (`apiKey`) or an extra token holds a secret.
const unexpectedKey = { messageUnexpectedKey: "not a field of a credential" } as const

export const CredentialInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("api_key"), key: secret }).annotate(unexpectedKey),
  Schema.Struct({
    type: Schema.Literal("oauth"),
    access: secret,
    refresh: secret,
    /** Absolute expiry, epoch ms. */
    expires: Schema.Number.annotate({ message: "expires is the access token's expiry, in epoch ms" }).check(Schema.isFinite()),
    accountId: Schema.optionalKey(AccountId),
    installationId: Schema.optionalKey(InstallationId),
  }).annotate(unexpectedKey),
  Schema.Struct({ type: Schema.Literal("local"), baseUrl: Schema.optionalKey(Schema.String) }).annotate(unexpectedKey),
]).annotate({
  message: "a credential is { type: \"api_key\", key }, { type: \"oauth\", access, refresh, expires, accountId?, installationId? } or { type: \"local\", baseUrl? }, with Redacted secrets",
})
export type CredentialInput = typeof CredentialInput.Type

/**
 * Credentials by provider id.
 *
 * @public
 */
export const CredentialInputs = Schema.Record(Schema.String, CredentialInput).annotate({
  message: "credentials maps provider ids to credentials",
})
export type CredentialInputs = typeof CredentialInputs.Type
