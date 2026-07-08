import { Effect, Option } from "effect"
import { AuthError } from "@xandreed/engine"

/**
 * Anthropic OAuth (Claude Pro/Max subscription) — the full protocol:
 * authorization-code + PKCE (begin/exchange) and refresh. Constants match
 * the public Claude Code OAuth client (the client id is not a secret).
 * These are pure protocol helpers; the loopback callback server and the
 * browser-open live in the TUI driver.
 */

export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
export const ANTHROPIC_CALLBACK_PORT = 53692
export const ANTHROPIC_CALLBACK_PATH = "/callback"
export const ANTHROPIC_REDIRECT_URI = `http://localhost:${ANTHROPIC_CALLBACK_PORT}${ANTHROPIC_CALLBACK_PATH}`
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

/** Beta flags the subscription path requires (Claude Code identity + oauth). */
export const ANTHROPIC_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20"
/** Anthropic rejects OAuth tokens unless the first system block is exactly this. */
export const CLAUDE_CODE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude."

export interface RefreshedTokens {
  readonly access: string
  readonly refresh: string
  /** Absolute expiry, epoch ms (with a 5-minute early-refresh skew baked in). */
  readonly expires: number
}

const oauthError = (stage: string) => (detail: string): AuthError =>
  new AuthError({
    provider: "anthropic",
    message: `OAuth ${stage} failed: ${detail}`,
  })

/** One token-endpoint POST; refresh and exchange share it verbatim. */
const postToken = (
  body: Record<string, string>,
  stage: string,
): Effect.Effect<RefreshedTokens, AuthError> => {
  const fail = oauthError(stage)
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      return { ok: res.ok, status: res.status, text: await res.text() }
    },
    catch: (e) => fail(String(e)),
  }).pipe(
    Effect.filterOrFail(
      (res) => res.ok,
      (res) => fail(`status ${res.status}: ${res.text.slice(0, 200)}`),
    ),
    Effect.flatMap((res) =>
      Effect.try({
        try: () =>
          JSON.parse(res.text) as {
            access_token: string
            refresh_token: string
            expires_in: number
          },
        catch: () => fail("the token response was not JSON"),
      }),
    ),
    Effect.map((data) => ({
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    })),
  )
}

/** Refresh an expired (or near-expiry) access token. */
export const refreshAnthropicToken = (
  refreshToken: string,
): Effect.Effect<RefreshedTokens, AuthError> =>
  postToken(
    {
      grant_type: "refresh_token",
      client_id: ANTHROPIC_CLIENT_ID,
      refresh_token: refreshToken,
    },
    "token refresh",
  )

/* ------------------------------------------------------------------ */
/* The authorize half (begin → user consents → exchange)               */
/* ------------------------------------------------------------------ */

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

const base64url = (bytes: Uint8Array): string =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")

/** Generate a PKCE verifier + S256 challenge (Web Crypto; Bun-global). */
export const generatePkce: Effect.Effect<Pkce> = Effect.promise(async () => {
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64url(verifierBytes)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)) }
})

export interface OAuthBegin {
  /** The PKCE verifier — ALSO the `state`; the driver must verify the
   *  redirect echoes it (CSRF) before exchanging. */
  readonly verifier: string
  readonly authorizeUrl: string
  readonly callbackPort: number
  readonly callbackPath: string
}

/** Start an authorization: PKCE material + the browser URL. */
export const beginAnthropicOAuth: Effect.Effect<OAuthBegin> = Effect.map(
  generatePkce,
  (pkce) => ({
    verifier: pkce.verifier,
    authorizeUrl: `${AUTHORIZE_URL}?${new URLSearchParams({
      code: "true",
      client_id: ANTHROPIC_CLIENT_ID,
      response_type: "code",
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      scope: SCOPES,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state: pkce.verifier,
    }).toString()}`,
    callbackPort: ANTHROPIC_CALLBACK_PORT,
    callbackPath: ANTHROPIC_CALLBACK_PATH,
  }),
)

/** Exchange the authorization code for tokens. */
export const exchangeAnthropicCode = (
  code: string,
  verifier: string,
): Effect.Effect<RefreshedTokens, AuthError> =>
  postToken(
    {
      grant_type: "authorization_code",
      client_id: ANTHROPIC_CLIENT_ID,
      code,
      redirect_uri: ANTHROPIC_REDIRECT_URI,
      code_verifier: verifier,
      state: verifier,
    },
    "code exchange",
  )

export interface AuthRedirect {
  readonly code: Option.Option<string>
  readonly state: Option.Option<string>
}

const fromNullableTrimmed = (value: string | null | undefined): Option.Option<string> =>
  Option.filter(Option.fromNullable(value), (v) => v.trim().length > 0)

/** Pull `code`/`state` out of a pasted redirect URL, `code#state` pair,
 *  bare query string, or raw code. Total — garbage is `{none, none}`. */
export const parseAuthorizationInput = (input: string): AuthRedirect => {
  const value = input.trim()
  if (value.length === 0) return { code: Option.none(), state: Option.none() }
  if (URL.canParse(value)) {
    const url = new URL(value)
    return {
      code: fromNullableTrimmed(url.searchParams.get("code")),
      state: fromNullableTrimmed(url.searchParams.get("state")),
    }
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return { code: fromNullableTrimmed(code), state: fromNullableTrimmed(state) }
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value)
    return {
      code: fromNullableTrimmed(params.get("code")),
      state: fromNullableTrimmed(params.get("state")),
    }
  }
  return { code: Option.some(value), state: Option.none() }
}
