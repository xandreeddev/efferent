import { AuthError, type OAuthTokens } from "@efferent/core"
import { Effect } from "effect"

/**
 * Anthropic OAuth (Claude Pro/Max subscription) — authorization-code + PKCE.
 * Protocol constants match the public Claude Code OAuth client (the same flow
 * pi and other CLIs use); see `pi/packages/ai/src/utils/oauth/anthropic.ts`.
 * Pure protocol helpers; the callback server + browser-open live in the CLI
 * driver (`cli/src/login/oauthServer.ts`).
 */

// Public Claude Code OAuth client id (not a secret).
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
export const ANTHROPIC_CALLBACK_PORT = 53692
export const ANTHROPIC_REDIRECT_URI = `http://localhost:${ANTHROPIC_CALLBACK_PORT}/callback`
const SCOPES =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"

// Beta flags the subscription path requires (Claude Code identity + oauth).
export const ANTHROPIC_OAUTH_BETA = "claude-code-20250219,oauth-2025-04-20"
// Anthropic rejects OAuth tokens unless the first system block is exactly this.
export const CLAUDE_CODE_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude."

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

const base64url = (bytes: Uint8Array): string => {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

/** Generate a PKCE verifier + S256 challenge (Web Crypto; Bun-global). */
export const generatePkce = (): Effect.Effect<Pkce> =>
  Effect.promise(async () => {
    const verifierBytes = new Uint8Array(32)
    crypto.getRandomValues(verifierBytes)
    const verifier = base64url(verifierBytes)
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    )
    return { verifier, challenge: base64url(new Uint8Array(digest)) }
  })

/** The browser authorize URL. pi uses the PKCE verifier as the `state`. */
export const anthropicAuthorizeUrl = (pkce: Pkce): string => {
  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.verifier,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

/** Pull `code`/`state` out of a pasted redirect URL or raw code. */
export const parseAuthorizationInput = (
  input: string,
): { code?: string | undefined; state?: string | undefined } => {
  const value = input.trim()
  if (!value) return {}
  try {
    const url = new URL(value)
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    }
  } catch {
    /* not a URL */
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2)
    return { code, state }
  }
  if (value.includes("code=")) {
    const p = new URLSearchParams(value)
    return {
      code: p.get("code") ?? undefined,
      state: p.get("state") ?? undefined,
    }
  }
  return { code: value }
}

const postToken = (
  body: Record<string, string>,
): Effect.Effect<OAuthTokens, AuthError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`status ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = JSON.parse(text) as {
        access_token: string
        refresh_token: string
        expires_in: number
      }
      return {
        access: data.access_token,
        refresh: data.refresh_token,
        // Refresh a little early (pi uses a 5-minute skew).
        expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
      } satisfies OAuthTokens
    },
    catch: (e) =>
      new AuthError({ provider: "anthropic", message: `OAuth token request failed: ${String(e)}` }),
  })

/** Exchange an authorization code for tokens (PKCE `state` = verifier). */
export const exchangeAnthropicCode = (
  code: string,
  verifier: string,
): Effect.Effect<OAuthTokens, AuthError> =>
  postToken({
    grant_type: "authorization_code",
    client_id: ANTHROPIC_CLIENT_ID,
    code,
    state: verifier,
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    code_verifier: verifier,
  })

/** Refresh an expired access token. */
export const refreshAnthropicToken = (
  refreshToken: string,
): Effect.Effect<OAuthTokens, AuthError> =>
  postToken({
    grant_type: "refresh_token",
    client_id: ANTHROPIC_CLIENT_ID,
    refresh_token: refreshToken,
  })
