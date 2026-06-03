import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  AuthError,
  AuthStore,
  type AuthData,
  type Credential,
  type OAuthTokens,
  type Provider,
} from "@efferent/core"
import { Effect, Layer, Redacted, Ref } from "effect"
import { refreshAnthropicToken } from "./oauth/anthropic.js"
import { refreshOpenAiToken } from "./oauth/openai.js"

/** Refresh an OAuth token when it's within this window of expiry. */
const REFRESH_SKEW_MS = 60_000

/**
 * `AuthStore` backed by `~/.efferent/auth.json`. Credentials come **only** from
 * that file (written by the in-app `:login` flow) — no env-var reading. The
 * file is a per-provider map:
 *
 * ```json
 * {
 *   "anthropic": { "type": "oauth", "access": "…", "refresh": "…", "expires": 1788… },
 *   "openai":    { "type": "api_key", "key": "sk-…" }
 * }
 * ```
 *
 * Reads at layer-build into a `Ref`; mutations rewrite the file atomically with
 * mode `0600`. `resolveKey` is read lazily per request by the router/registry,
 * so a credential added mid-session works on the next turn with no restart.
 */

const PROVIDERS = ["google", "openai", "anthropic"] as const

// `~/.efferent`, or `<EFFERENT_HOME>/.efferent` when that env var points
// elsewhere (relocate config / test isolation). This is a directory knob, not
// a credential — credentials themselves are never read from the env.
const authDir = (): string => {
  const override = process.env.EFFERENT_HOME
  return join(override !== undefined && override.length > 0 ? override : homedir(), ".efferent")
}
const authFilePath = (): string => join(authDir(), "auth.json")

const isProvider = (s: string): s is Provider =>
  (PROVIDERS as ReadonlyArray<string>).includes(s)

/**
 * Parse auth.json defensively. Accepts the current per-provider object form
 * and the legacy flat-string form (`{ "<p>": "<key>" }`, written by the old
 * `efferent init`) which is read as an api_key. Anything malformed is dropped
 * so a broken file never blocks login.
 */
const parseAuth = (raw: string): AuthData => {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof json !== "object" || json === null) return {}
  const out: Record<string, Credential> = {}
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (!isProvider(k)) continue
    if (typeof v === "string" && v.length > 0) {
      out[k] = { type: "api_key", key: v }
      continue
    }
    if (typeof v !== "object" || v === null) continue
    const o = v as Record<string, unknown>
    if (o.type === "api_key" && typeof o.key === "string" && o.key.length > 0) {
      out[k] = { type: "api_key", key: o.key }
    } else if (
      o.type === "oauth" &&
      typeof o.access === "string" &&
      typeof o.refresh === "string" &&
      typeof o.expires === "number"
    ) {
      out[k] = {
        type: "oauth",
        access: o.access,
        refresh: o.refresh,
        expires: o.expires,
        ...(typeof o.accountId === "string" && o.accountId.length > 0
          ? { accountId: o.accountId }
          : {}),
      }
    }
  }
  return out
}

const readAuthFile = (): AuthData => {
  try {
    const p = authFilePath()
    if (!existsSync(p)) return {}
    return parseAuth(readFileSync(p, "utf8"))
  } catch {
    return {}
  }
}

const writeAuthFile = (data: AuthData): void => {
  mkdirSync(authDir(), { recursive: true })
  const p = authFilePath()
  const tmp = `${p}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, p)
}

const oauthCredential = (tokens: OAuthTokens): Credential => ({
  type: "oauth",
  access: tokens.access,
  refresh: tokens.refresh,
  expires: tokens.expires,
  ...(tokens.accountId !== undefined ? { accountId: tokens.accountId } : {}),
})

export const LocalAuthStoreLive = Layer.effect(
  AuthStore,
  Effect.gen(function* () {
    const ref = yield* Ref.make<AuthData>(readAuthFile())

    const write = (provider: Provider, next: AuthData) =>
      Effect.try({
        try: () => writeAuthFile(next),
        catch: (e) =>
          new AuthError({
            provider,
            message: `failed to write auth.json: ${String(e)}`,
          }),
      }).pipe(Effect.zipRight(Ref.set(ref, next)))

    const set = (provider: Provider, cred: Credential) =>
      Ref.get(ref).pipe(
        Effect.flatMap((cur) => write(provider, { ...cur, [provider]: cred })),
      )

    return AuthStore.of({
      all: Ref.get(ref),

      get: (p) => Ref.get(ref).pipe(Effect.map((d) => d[p])),

      resolveKey: (p) =>
        Ref.get(ref).pipe(
          Effect.flatMap((d) => {
            const cred = d[p]
            if (cred === undefined) return Effect.succeed(undefined)
            if (cred.type === "api_key") return Effect.succeed(Redacted.make(cred.key))
            // OAuth: hand back the access token, refreshing + persisting first
            // when it's near expiry.
            if (cred.expires - Date.now() > REFRESH_SKEW_MS) {
              return Effect.succeed(Redacted.make(cred.access))
            }
            const refresh =
              p === "anthropic"
                ? refreshAnthropicToken(cred.refresh)
                : p === "openai"
                  ? refreshOpenAiToken(cred.refresh)
                  : Effect.succeed({
                      access: cred.access,
                      refresh: cred.refresh,
                      expires: cred.expires,
                      ...(cred.accountId !== undefined ? { accountId: cred.accountId } : {}),
                    } satisfies OAuthTokens)
            return refresh.pipe(
              Effect.flatMap((tokens) =>
                set(p, oauthCredential(tokens)).pipe(
                  Effect.as(Redacted.make(tokens.access)),
                ),
              ),
            )
          }),
        ),

      setApiKey: (p, key) => set(p, { type: "api_key", key }),

      setOAuth: (p, tokens: OAuthTokens) => set(p, oauthCredential(tokens)),

      remove: (p) =>
        Ref.get(ref).pipe(
          Effect.flatMap((cur) => {
            const next = { ...cur }
            delete next[p]
            return write(p, next)
          }),
        ),
    })
  }),
)
