import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { Effect, Option } from "effect"
import type { ProviderId } from "@xandreed/core"
import type { AuthStoreRefreshProbe } from "@xandreed/core/models"
import type { ModelsFetch } from "./ports/models-transport.port.js"

/**
 * A file damaged for the scope's lifetime: it holds text that is not JSON,
 * then its old bytes again (or no file, when there was none). The `corrupt`
 * option of the AuthStore and SettingsStore kits, for the local stores.
 */
export const damagedFile = (path: string) => Effect.acquireRelease(
  Effect.sync(() => {
    const before = existsSync(path) ? Option.some(readFileSync(path)) : Option.none<Buffer>()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{ not json")
    return before
  }),
  (before) => Effect.sync(() => Option.match(before, { onNone: () => rmSync(path, { force: true }), onSome: (bytes) => writeFileSync(path, bytes) })),
).pipe(Effect.asVoid)

/**
 * A token endpoint for both subscription providers: each request gets a
 * fresh access and refresh token (`<label>-access-<n>`), valid for an hour,
 * once no hold is in place. `probe` is the AuthStore kit's view of it, for
 * the refreshes of `provider`; build the store over `fetch`.
 */
export const tokenEndpoint = (provider: ProviderId, label = "fresh") => {
  const state = { requests: 0, gate: Promise.resolve() }
  const fetch: ModelsFetch = async () => {
    state.requests += 1
    const n = state.requests
    await state.gate
    return Response.json({ access_token: `${label}-access-${n}`, refresh_token: `${label}-refresh-${n}`, expires_in: 3600 })
  }
  const probe: AuthStoreRefreshProbe = {
    provider,
    requests: Effect.sync(() => state.requests),
    hold: Effect.sync(() => {
      const gate = Promise.withResolvers<void>()
      state.gate = gate.promise
      return Effect.sync(() => {
        state.gate = Promise.resolve()
        gate.resolve()
      })
    }),
  }
  return { fetch, probe }
}
