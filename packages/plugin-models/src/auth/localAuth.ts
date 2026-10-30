import { join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import type { Context } from "effect"
import { AuthError, AuthStore, Credential } from "@xandreed/core/models"
import type { ProviderId } from "@xandreed/core"
import { encodeCredential } from "./credential-input.entity.functions.js"
import { isSameToken, resolveSlotKey } from "./credential-refresh.entity.functions.js"
import type { CredentialSlot } from "./credential-refresh.entity.functions.js"
import type { TokenRequestOptions } from "./anthropicOAuth.js"
import { ModelsTransport } from "../ports/models-transport.port.js"
import { namedLock, readJsonObject, withFileLock, writeJsonObject } from "../storage/json-file.js"

/**
 * The on-disk credential store — the SAME `auth.json` vocabulary the previous
 * line established, so existing logins keep working: a global
 * `~/.efferent/auth.json` merged with a local `<cwd>/.efferent/auth.json`
 * (local overrides global per provider). Legacy flat-string entries read as
 * api keys. `resolveKey` refreshes a near-expiry OAuth token first and
 * persists the refreshed credential back to the file that held it. Secrets
 * are `Redacted` once read and in the clear in the file: every entry is
 * encoded through `Credential` before it is written.
 */

interface AuthFile {
  readonly path: string
  readonly entries: ReadonlyMap<string, Credential>
  /** The entries this version cannot read: never listed, and written back as they are. */
  readonly unread: ReadonlyMap<string, Schema.Json>
}

const decodeStored = Schema.decodeUnknownOption(Credential)
/** A flat string is a legacy api key. */
const decodeLegacyKey = Schema.decodeUnknownOption(Schema.String)

/** An entry as a `Credential`, or a legacy flat string as an api key, its secrets `Redacted`; none for anything else (a field of the wrong type included). */
const decodeCredential = (raw: Schema.Json): Option.Option<Credential> =>
  Option.orElse(decodeStored(raw), () => Option.flatMap(decodeLegacyKey(raw), (key) => decodeStored({ type: "api_key", key })))

const corrupt = (path: string) => (reason: string) => new AuthError({
  provider: "*",
  code: "auth.corrupt",
  message: `${path} ${reason}: fix or remove it; nothing was read from it or written to it`,
})

/** A file that is not there reads as empty; one that cannot be read or is not a JSON object fails with `auth.corrupt`. */
const readAuthFile = (path: string): Effect.Effect<AuthFile, AuthError> =>
  readJsonObject(path, corrupt(path)).pipe(Effect.map((record) => {
    const decoded = Object.entries(Option.getOrElse(record, () => ({}))).map(([provider, raw]) => ({ provider, raw, credential: decodeCredential(raw) }))
    return {
      path,
      entries: new Map(decoded.flatMap(({ provider, credential }) => Option.match(credential, {
        onNone: () => [],
        onSome: (found) => [[provider, found] as const],
      }))),
      unread: new Map(decoded.filter(({ credential }) => Option.isNone(credential)).map(({ provider, raw }) => [provider, raw] as const)),
    }
  }))

/**
 * Write `file` with `provider` set to `credential` (or removed), every other
 * entry kept. Every credential is encoded first, its secrets in the clear:
 * `JSON.stringify` of a `Credential` writes `"<redacted>"`, which would erase
 * them. One that does not encode fails the write before anything changes.
 * Atomic, mode 0600.
 */
const writeAuthFile = (file: AuthFile, provider: string, credential: Option.Option<Credential>): Effect.Effect<void, AuthError> => {
  const others = <A>(entries: ReadonlyMap<string, A>) => [...entries].filter(([key]) => key !== provider)
  const credentials = [...others(file.entries), ...Option.toArray(Option.map(credential, (value) => [provider, value] as const))]
  return Effect.forEach(credentials, ([key, value]) => Effect.map(encodeCredential(key, value), (encoded) => [key, encoded] as const), { concurrency: 1 }).pipe(
    Effect.flatMap((encoded) => {
      // Typed as JSON, so a decoded credential (its secrets `Redacted`) cannot be written by mistake.
      const record: Schema.JsonObject = Object.fromEntries([...others(file.unread), ...encoded])
      return writeJsonObject(file.path, record, Option.some(0o600), (reason) => new AuthError({ provider: "*", message: `auth.json write failed: ${reason}` }))
    }),
  )
}

export const authPaths = (cwd: string, home: string, directory = ".efferent"): ReadonlyArray<string> => [
  join(home, directory, "auth.json"),
  join(cwd, directory, "auth.json"),
]

/** The file a provider's credential is read from: the last of `files` that holds it. */
const holderOf = (files: ReadonlyArray<AuthFile>, provider: ProviderId): Option.Option<{ readonly file: AuthFile; readonly credential: Credential }> =>
  Option.firstSomeOf([...files].reverse().map((file) => Option.map(Option.fromNullishOr(file.entries.get(provider)), (credential) => ({ file, credential }))))

/**
 * `LocalAuthStoreLive(cwd, home)` — read-through: every call re-reads disk,
 * so a credential added mid-session applies on the next request. A token
 * refresh goes through the `ModelsTransport` the layer is built over, if any.
 *
 * A file that cannot be read or is not a JSON object fails every call with
 * an `AuthError` of code `auth.corrupt`; only a missing file reads as empty.
 * Each write re-reads its file under that file's lock, which every store in
 * the process shares, and replaces it through a temp file of its own. One
 * refresh of a provider's token runs at a time, and stores its token only if
 * the provider still holds the one it refreshed, so a login or logout made
 * during the refresh wins. The locks hold within one process: two processes
 * sharing these files can still lose an update.
 */
export const LocalAuthStoreLive = (cwd: string, home: string, directory = ".efferent", fallbackDirectory?: string) => {
  const writable = authPaths(cwd, home, directory)
  const loginPath = writable[0] ?? join(home, directory, "auth.json")
  const paths = [...(fallbackDirectory === undefined ? [] : authPaths(cwd, home, fallbackDirectory)), ...writable]
  const readAll = Effect.forEach(paths, readAuthFile, { concurrency: 1 })
  /** Where a refreshed token is written: the runtime file that held it, else the global runtime file. */
  const targetOf = (path: string) => writable.includes(path) ? path : loginPath

  return Layer.effect(AuthStore, Effect.map(Effect.serviceOption(ModelsTransport), (transport): Context.Service.Shape<typeof AuthStore> => {
    const tokens: TokenRequestOptions = Option.match(transport, { onNone: () => ({}), onSome: ({ fetch }) => ({ fetch }) })

    const slotOf = (provider: ProviderId): CredentialSlot => ({
      current: Effect.map(readAll, (files) => Option.map(holderOf(files, provider), ({ credential }) => credential)),
      refreshLock: namedLock(loginPath, `refresh:${provider}`),
      commit: (stale, fresh) => Effect.map(readAll, (files) => holderOf(files, provider)).pipe(Effect.flatMap(Option.match({
        onNone: () => Effect.succeed(false),
        onSome: ({ file }) => {
          const target = targetOf(file.path)
          return withFileLock(target)(Effect.gen(function* () {
            // Read again under the lock: only the token this refresh replaced may be replaced.
            const now = holderOf(yield* readAll, provider)
            if (!Option.exists(now, (held) => targetOf(held.file.path) === target && isSameToken(held.credential, stale))) return false
            yield* writeAuthFile(yield* readAuthFile(target), provider, Option.some(fresh))
            return true
          }))
        },
      }))),
    })

    return {
      all: Effect.map(readAll, (files) => new Map(files.flatMap((f) => [...f.entries]))),
      get: (provider: ProviderId) => slotOf(provider).current,
      resolveKey: (provider: ProviderId) => resolveSlotKey(provider, slotOf(provider), tokens),
      set: (provider: ProviderId, credential: Credential) =>
        withFileLock(loginPath)(readAuthFile(loginPath).pipe(Effect.flatMap((file) => writeAuthFile(file, provider, Option.some(credential))))),
      // Every file is read first, so a corrupt one fails the logout before any file changes.
      remove: (provider: ProviderId) => readAll.pipe(
        Effect.andThen(Effect.forEach(paths, (path) => withFileLock(path)(readAuthFile(path).pipe(Effect.flatMap((file) =>
          file.entries.has(provider) || file.unread.has(provider) ? writeAuthFile(file, provider, Option.none()) : Effect.void))), { concurrency: 1, discard: true })),
      ),
    }
  }))
}
