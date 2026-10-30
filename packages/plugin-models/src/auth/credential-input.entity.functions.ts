import { Effect, Match, Schema } from "effect"
import { AuthError, Credential } from "../ports/auth-store.port.js"
import { AccountId, InstallationId } from "./credential-input.entity.js"
import type { CredentialInput, CredentialInputs } from "./credential-input.entity.js"

const encode = Schema.encodeEffect(Credential)

/**
 * A credential in its stored form, secrets in the clear: what `auth.json`
 * holds for it. A secret that is not `Redacted` (a plain string from
 * untyped code), or a field the credential does not type so, fails with an
 * `AuthError` naming the provider, never the value.
 */
export const encodeCredential = (provider: string, credential: Credential): Effect.Effect<typeof Credential.Encoded, AuthError> =>
  encode(credential).pipe(Effect.mapError(() => new AuthError({
    provider,
    message: `the ${provider} credential cannot be stored: its secrets must be Redacted values (Redacted.make(...)), and its other fields those of a credential`,
  })))

/**
 * A stored credential as a host receives it: the same secrets, already
 * `Redacted`, and an OAuth credential's account and installation ids
 * branded (`AccountId`, `InstallationId`).
 */
export const toCredentialInput = (credential: Credential): CredentialInput =>
  Match.value(credential).pipe(
    Match.when({ type: "api_key" }, (apiKey): CredentialInput => apiKey),
    Match.when({ type: "oauth" }, ({ accountId, installationId, ...oauth }): CredentialInput => ({
      ...oauth,
      ...(accountId === undefined ? {} : { accountId: AccountId.make(accountId) }),
      ...(installationId === undefined ? {} : { installationId: InstallationId.make(installationId) }),
    })),
    Match.when({ type: "local" }, (local): CredentialInput => local),
    Match.exhaustive,
  )

/** Handed-over credentials, by provider id, as the store keeps them. */
export const credentialsOf = (inputs: CredentialInputs): ReadonlyMap<string, Credential> => new Map(Object.entries(inputs))
