import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { Effect, Layer, Option, Redacted } from "effect"
import { AuthError, AuthStore } from "@xandreed/engine"
import type { Credential, ProviderId } from "@xandreed/engine"
import { refreshAnthropicToken } from "./anthropicOAuth.js"

/**
 * The on-disk credential store — the SAME `auth.json` vocabulary the previous
 * line established, so existing logins keep working: a global
 * `~/.efferent/auth.json` merged with a local `<cwd>/.efferent/auth.json`
 * (local overrides global per provider). Legacy flat-string entries read as
 * api keys. `resolveKey` refreshes a near-expiry OAuth token first and
 * persists the refreshed credential back to the file that held it.
 */

interface AuthFile {
  readonly path: string
  readonly entries: ReadonlyMap<string, Credential>
}

const decodeCredential = (value: unknown): Option.Option<Credential> => {
  if (typeof value === "string") {
    return Option.some({ type: "api_key", key: value })
  }
  if (typeof value !== "object" || value === null) return Option.none()
  const v = value as Record<string, unknown>
  if (v["type"] === "api_key" && typeof v["key"] === "string") {
    return Option.some({ type: "api_key", key: v["key"] })
  }
  if (
    v["type"] === "oauth" &&
    typeof v["access"] === "string" &&
    typeof v["refresh"] === "string" &&
    typeof v["expires"] === "number"
  ) {
    return Option.some({
      type: "oauth",
      access: v["access"],
      refresh: v["refresh"],
      expires: v["expires"],
      ...(typeof v["accountId"] === "string" ? { accountId: v["accountId"] } : {}),
      ...(typeof v["installationId"] === "string"
        ? { installationId: v["installationId"] }
        : {}),
    })
  }
  if (v["type"] === "local") {
    return Option.some({
      type: "local",
      ...(typeof v["baseUrl"] === "string" ? { baseUrl: v["baseUrl"] } : {}),
    })
  }
  return Option.none()
}

const readAuthFile = (path: string): Effect.Effect<AuthFile> =>
  Effect.tryPromise({ try: () => readFile(path, "utf-8"), catch: () => "missing" as const }).pipe(
    Effect.map((text) => {
      const parsed = Effect.runSync(
        Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => ({}) }).pipe(
          Effect.orElseSucceed(() => ({})),
        ),
      )
      const record =
        typeof parsed === "object" && parsed !== null
          ? (parsed as Record<string, unknown>)
          : {}
      const entries = new Map(
        Object.entries(record).flatMap(([provider, raw]) =>
          Option.match(decodeCredential(raw), {
            onNone: () => [] as ReadonlyArray<readonly [string, Credential]>,
            onSome: (cred) => [[provider, cred] as const],
          }),
        ),
      )
      return { path, entries }
    }),
    Effect.orElseSucceed(() => ({ path, entries: new Map<string, Credential>() })),
  )

/** Atomic 0600 write: temp file in the same dir, then rename over. */
const writeAuthFile = (
  path: string,
  entries: ReadonlyMap<string, Credential>,
): Effect.Effect<void, AuthError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(path), { recursive: true })
      const tmp = `${path}.tmp-${process.pid}`
      await writeFile(tmp, JSON.stringify(Object.fromEntries(entries), null, 2), "utf-8")
      await chmod(tmp, 0o600)
      await rename(tmp, path)
    },
    catch: (e) =>
      new AuthError({ provider: "*", message: `auth.json write failed: ${String(e)}` }),
  })

/** Refresh this many ms before the recorded expiry. */
const REFRESH_SKEW_MS = 60_000

export const authPaths = (cwd: string, home: string): ReadonlyArray<string> => [
  join(home, ".efferent", "auth.json"),
  join(cwd, ".efferent", "auth.json"),
]

/**
 * `LocalAuthStoreLive(cwd, home)` — read-through: every call re-reads disk,
 * so a credential added mid-session applies on the next request.
 */
export const LocalAuthStoreLive = (cwd: string, home: string) =>
  Layer.succeed(AuthStore, {
    all: Effect.gen(function* () {
      const files = yield* Effect.forEach(authPaths(cwd, home), readAuthFile)
      return new Map(files.flatMap((f) => [...f.entries]))
    }),
    get: (provider: ProviderId) =>
      Effect.gen(function* () {
        // Local overrides global: read in order, later files win.
        const files = yield* Effect.forEach(authPaths(cwd, home), readAuthFile)
        const merged = new Map(files.flatMap((f) => [...f.entries]))
        return Option.fromNullable(merged.get(provider))
      }),
    resolveKey: (provider: ProviderId) =>
      Effect.gen(function* () {
        const files = yield* Effect.forEach(authPaths(cwd, home), readAuthFile)
        const holder = [...files]
          .reverse()
          .find((f) => f.entries.has(provider))
        const cred = holder?.entries.get(provider)
        if (cred === undefined) return Option.none<Redacted.Redacted<string>>()
        if (cred.type === "api_key") return Option.some(Redacted.make(cred.key))
        if (cred.type === "local") return Option.none<Redacted.Redacted<string>>()
        // OAuth: refresh when near expiry, persisting back to the file that
        // held the credential. Only Anthropic's refresh protocol is wired on
        // the new line; other OAuth providers surface a clear error.
        if (cred.expires > Date.now() + REFRESH_SKEW_MS) {
          return Option.some(Redacted.make(cred.access))
        }
        if (provider !== "anthropic") {
          return yield* Effect.fail(
            new AuthError({
              provider,
              message: `the ${provider} OAuth token expired and its refresh flow isn't wired on the new line — re-login or use an API key`,
            }),
          )
        }
        const fresh = yield* refreshAnthropicToken(cred.refresh)
        const updated: Credential = { ...cred, ...fresh }
        const target = holder ?? { path: authPaths(cwd, home)[0] ?? "", entries: new Map() }
        yield* writeAuthFile(
          target.path,
          new Map([...target.entries, [provider, updated] as const]),
        )
        return Option.some(Redacted.make(fresh.access))
      }),
  })
