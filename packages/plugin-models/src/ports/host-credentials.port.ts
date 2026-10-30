import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { ProviderId } from "@xandreed/core"
import type { AuthError } from "@xandreed/core/models"
import type { CredentialInput } from "../auth/credential-input.entity.js"

/**
 * Credentials a host keeps itself (a secrets manager, a database, its own
 * session store), for the models plugin with `storage: "memory"`. `load` is
 * read once, when the plugin starts; `save` is called after every change the
 * AuthStore makes — a login (`set`), a logout (`None`), an OAuth token
 * refreshed in memory — so the host can keep the new value. Secrets cross
 * this port `Redacted`. A failed `save` fails a login or logout (memory is
 * left as it was) but not a refresh: the refreshed token is already the
 * only valid one, so it stays in memory and the failure is logged.
 */
export class HostCredentials extends Context.Service<HostCredentials, {
  readonly load: Effect.Effect<ReadonlyMap<string, CredentialInput>, AuthError>
  readonly save: (provider: ProviderId, credential: Option.Option<CredentialInput>) => Effect.Effect<void, AuthError>
}>()("@xandreed/plugin-models/HostCredentials") {}
