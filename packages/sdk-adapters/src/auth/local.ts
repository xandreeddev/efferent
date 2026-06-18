import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import {
  AuthError,
  AuthStore,
  type AuthData,
  type ConfigScope,
  type Credential,
  type OAuthTokens,
  type Provider,
} from "@xandreed/sdk-core"
import { Effect, Layer, Redacted, Ref } from "effect"
import {
  type ConfigRoots,
  dirForScope,
  ensureLocalGitignore,
  resolveConfigRoots,
} from "../configRoots.js"
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

const PROVIDERS = ["google", "openai", "anthropic", "opencode", "ollama"] as const

/** `auth.json` inside a resolved `.efferent` dir (global or local tier). */
const authFileIn = (efferentDir: string): string => join(efferentDir, "auth.json")

const isProvider = (s: string): s is Provider =>
  (PROVIDERS as ReadonlyArray<string>).includes(s)

/**
 * Parse auth.json defensively. Accepts the current per-provider object form
 * and the legacy flat-string form (`{ "<p>": "<key>" }`, written by the old
 * `efferent init`) which is read as an api_key. Anything malformed is dropped
 * so a broken file never blocks login.
 */
const parseAuth = (raw: string): { data: AuthData; changed: boolean } => {
  let changed = false
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { data: {}, changed }
  }
  if (typeof json !== "object" || json === null) return { data: {}, changed }
  const out: Record<string, Credential> = {}
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (!isProvider(k)) continue
    if (typeof v === "string" && v.length > 0) {
      out[k] = { type: "api_key", key: v }
      continue
    }
    if (typeof v !== "object" || v === null) continue
    const o = v as Record<string, unknown>
    if (o.type === "local") {
      out[k] = {
        type: "local",
        ...(typeof o.baseUrl === "string" && o.baseUrl.length > 0 ? { baseUrl: o.baseUrl } : {}),
      }
    } else if (o.type === "api_key" && typeof o.key === "string" && o.key.length > 0) {
      out[k] = { type: "api_key", key: o.key }
    } else if (
      o.type === "oauth" &&
      typeof o.access === "string" &&
      typeof o.refresh === "string" &&
      typeof o.expires === "number"
    ) {
      const installationId =
        k === "openai"
          ? typeof o.installationId === "string" && o.installationId.length > 0
            ? o.installationId
            : randomUUID()
          : typeof o.installationId === "string" && o.installationId.length > 0
            ? o.installationId
            : undefined
      if (k === "openai" && typeof o.installationId !== "string") changed = true
      out[k] = {
        type: "oauth",
        access: o.access,
        refresh: o.refresh,
        expires: o.expires,
        ...(typeof o.accountId === "string" && o.accountId.length > 0
          ? { accountId: o.accountId }
          : {}),
        ...(installationId !== undefined ? { installationId } : {}),
      }
    }
  }
  return { data: out, changed }
}

const readAuthFile = (efferentDir: string): AuthData => {
  try {
    const p = authFileIn(efferentDir)
    if (!existsSync(p)) return {}
    const parsed = parseAuth(readFileSync(p, "utf8"))
    if (parsed.changed) {
      try {
        writeAuthFile(efferentDir, parsed.data)
      } catch {
        // Best-effort migration only; keep the in-memory credential usable.
      }
    }
    return parsed.data
  } catch {
    return {}
  }
}

const writeAuthFile = (efferentDir: string, data: AuthData): void => {
  mkdirSync(efferentDir, { recursive: true })
  const p = authFileIn(efferentDir)
  const tmp = `${p}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, p)
}

const oauthCredential = (provider: Provider, tokens: OAuthTokens): Credential => ({
  type: "oauth",
  access: tokens.access,
  refresh: tokens.refresh,
  expires: tokens.expires,
  ...(tokens.accountId !== undefined ? { accountId: tokens.accountId } : {}),
  ...(provider === "openai"
    ? {
        installationId: tokens.installationId ?? randomUUID(),
      }
    : tokens.installationId !== undefined
      ? { installationId: tokens.installationId }
      : {}),
})

export const LocalAuthStoreLive = Layer.effect(
  AuthStore,
  Effect.gen(function* () {
    // Per-tier on-disk credentials + the merged read view (local overrides
    // global per provider). Roots default to the build-time cwd so the store is
    // usable before `init` (the common no-`--cwd` case); `init(cwd)` corrects it.
    const initialRoots = resolveConfigRoots(process.cwd())
    const rootsRef = yield* Ref.make<ConfigRoots>(initialRoots)
    const globalRef = yield* Ref.make<AuthData>(readAuthFile(initialRoots.global))
    const localRef = yield* Ref.make<AuthData>(
      initialRoots.single || initialRoots.local === undefined
        ? {}
        : readAuthFile(initialRoots.local),
    )
    const ref = yield* Ref.make<AuthData>({}) // merged
    // Single-flight gate for OAuth refreshes. resolveKey is called per request
    // — and requests are CONCURRENT now (tool concurrency + parallel
    // sub-agents) — so two near-expiry calls would otherwise both refresh,
    // and with rotating refresh tokens the loser's write poisons the stored
    // credential (silent logout). One gate across providers is fine: a
    // refresh is rare and fast.
    const refreshGate = yield* Effect.makeSemaphore(1)

    const recompute = Effect.gen(function* () {
      const g = yield* Ref.get(globalRef)
      const l = yield* Ref.get(localRef)
      yield* Ref.set(ref, { ...g, ...l })
    })
    yield* recompute

    const tierRefFor = (roots: ConfigRoots, scope: ConfigScope) =>
      roots.single || scope === "global" ? globalRef : localRef

    // Persist a mutation of one tier's credential map to that tier's file, then
    // re-merge. A local write seeds the per-folder `.gitignore`.
    const persist = (provider: Provider, scope: ConfigScope, mutate: (cur: AuthData) => AuthData) =>
      Effect.gen(function* () {
        const roots = yield* Ref.get(rootsRef)
        const tref = tierRefFor(roots, scope)
        const next = mutate(yield* Ref.get(tref))
        const dir = dirForScope(roots, scope)
        yield* Effect.try({
          try: () => writeAuthFile(dir, next),
          catch: (e) =>
            new AuthError({ provider, message: `failed to write auth.json: ${String(e)}` }),
        })
        yield* Ref.set(tref, next)
        if (!roots.single && (scope === "local")) yield* Effect.sync(() => ensureLocalGitignore(dir))
        yield* recompute
      })

    const set = (provider: Provider, cred: Credential, scope: ConfigScope = "global") =>
      persist(provider, scope, (cur) => ({ ...cur, [provider]: cred }))

    // After an OAuth refresh, write the rotated token back to whichever tier
    // currently holds the credential (local wins), so the merge stays coherent.
    const persistRefreshed = (provider: Provider, cred: Credential) =>
      Effect.gen(function* () {
        const roots = yield* Ref.get(rootsRef)
        const l = yield* Ref.get(localRef)
        const scope: ConfigScope = !roots.single && l[provider] !== undefined ? "local" : "global"
        yield* persist(provider, scope, (cur) => ({ ...cur, [provider]: cred }))
      })

    return AuthStore.of({
      init: (cwd) =>
        Effect.gen(function* () {
          const roots = resolveConfigRoots(cwd)
          yield* Ref.set(rootsRef, roots)
          yield* Ref.set(globalRef, readAuthFile(roots.global))
          yield* Ref.set(
            localRef,
            roots.single || roots.local === undefined ? {} : readAuthFile(roots.local),
          )
          yield* recompute
        }),

      all: Ref.get(ref),

      get: (p) => Ref.get(ref).pipe(Effect.map((d) => d[p])),

      resolveKey: (p) =>
        Ref.get(ref).pipe(
          Effect.flatMap((d) => {
            const cred = d[p]
            if (cred === undefined) return Effect.succeed(undefined)
            if (cred.type === "api_key") return Effect.succeed(Redacted.make(cred.key))
            // Local providers (Ollama) need no real key; return a dummy so the
            // router's key-plumbing stays uniform.
            if (cred.type === "local") return Effect.succeed(Redacted.make("ollama"))
            // OAuth: hand back the access token, refreshing + persisting first
            // when it's near expiry.
            if (cred.expires - Date.now() > REFRESH_SKEW_MS) {
              return Effect.succeed(Redacted.make(cred.access))
            }
            // Near-expiry: refresh under the single-flight gate, re-reading
            // inside it — the winner refreshes, every queued waiter sees the
            // fresh credential on its re-read and returns without a second
            // round-trip (or a second rotation).
            return refreshGate.withPermits(1)(
              Effect.gen(function* () {
                const cur = (yield* Ref.get(ref))[p]
                if (cur === undefined) return undefined
                if (cur.type !== "oauth") {
                  return cur.type === "api_key"
                    ? Redacted.make(cur.key)
                    : Redacted.make("ollama")
                }
                if (cur.expires - Date.now() > REFRESH_SKEW_MS) {
                  return Redacted.make(cur.access)
                }
                const refresh =
                  p === "anthropic"
                    ? refreshAnthropicToken(cur.refresh)
                    : p === "openai"
                      ? refreshOpenAiToken(cur.refresh)
                      : Effect.succeed({
                          access: cur.access,
                          refresh: cur.refresh,
                          expires: cur.expires,
                          ...(cur.accountId !== undefined ? { accountId: cur.accountId } : {}),
                          ...(cur.installationId !== undefined
                            ? { installationId: cur.installationId }
                            : {}),
                        } satisfies OAuthTokens)
                const tokens = yield* refresh.pipe(
                  Effect.map((tokens) => ({
                    ...tokens,
                    ...(tokens.installationId !== undefined || cur.installationId === undefined
                      ? {}
                      : { installationId: cur.installationId }),
                  })),
                  Effect.mapError(
                    (e) =>
                      new AuthError({
                        provider: p,
                        message: `OAuth token refresh failed (${e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)}) — run :login ${p} again.`,
                      }),
                  ),
                )
                yield* persistRefreshed(p, oauthCredential(p, tokens))
                return Redacted.make(tokens.access)
              }),
            )
          }),
        ),

      setApiKey: (p, key, scope) => set(p, { type: "api_key", key }, scope),

      setOAuth: (p, tokens: OAuthTokens, scope) => set(p, oauthCredential(p, tokens), scope),

      setLocal: (p, baseUrl, scope) =>
        set(
          p,
          { type: "local", ...(baseUrl !== undefined && baseUrl.length > 0 ? { baseUrl } : {}) },
          scope,
        ),

      // Forget the credential from BOTH tiers (it may live in either).
      remove: (p) =>
        Effect.gen(function* () {
          const roots = yield* Ref.get(rootsRef)
          const drop = (cur: AuthData): AuthData => {
            const next = { ...cur }
            delete next[p]
            return next
          }
          if ((yield* Ref.get(globalRef))[p] !== undefined) {
            yield* persist(p, "global", drop)
          }
          if (!roots.single && (yield* Ref.get(localRef))[p] !== undefined) {
            yield* persist(p, "local", drop)
          }
        }),
    })
  }),
)
