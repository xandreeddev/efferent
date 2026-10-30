import { Match, Redacted } from "effect"
import type { Credential } from "@xandreed/core"
import { AccountId, InstallationId } from "./credential-input.entity.js"
import type { CredentialInput, CredentialInputs } from "./credential-input.entity.js"

/** The stored form of a credential a host handed over: its secrets unwrapped. */
export const toCredential = (input: CredentialInput): Credential =>
  Match.value(input).pipe(
    Match.when({ type: "api_key" }, ({ key }): Credential => ({ type: "api_key", key: Redacted.value(key) })),
    Match.when({ type: "oauth" }, ({ access, refresh, ...rest }): Credential => ({ ...rest, access: Redacted.value(access), refresh: Redacted.value(refresh) })),
    Match.when({ type: "local" }, (local): Credential => local),
    Match.exhaustive,
  )

/** A stored credential as a host receives it: its secrets `Redacted`. */
export const toCredentialInput = (credential: Credential): CredentialInput =>
  Match.value(credential).pipe(
    Match.when({ type: "api_key" }, ({ key }): CredentialInput => ({ type: "api_key", key: Redacted.make(key) })),
    Match.when({ type: "oauth" }, ({ type, access, refresh, expires, accountId, installationId }): CredentialInput => ({
      type, expires, access: Redacted.make(access), refresh: Redacted.make(refresh),
      ...(accountId === undefined ? {} : { accountId: AccountId.make(accountId) }),
      ...(installationId === undefined ? {} : { installationId: InstallationId.make(installationId) }),
    })),
    Match.when({ type: "local" }, ({ type, baseUrl }): CredentialInput => ({ type, ...(baseUrl === undefined ? {} : { baseUrl }) })),
    Match.exhaustive,
  )

/** Handed-over credentials, by provider id, in their stored form. */
export const credentialsOf = (inputs: CredentialInputs): ReadonlyMap<string, Credential> =>
  new Map(Object.entries(inputs).map(([provider, input]) => [provider, toCredential(input)] as const))
