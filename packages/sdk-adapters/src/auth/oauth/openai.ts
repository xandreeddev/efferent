import { AuthError, type OAuthTokens } from "@efferent/sdk-core"
import { Effect } from "effect"
import { type Pkce } from "./anthropic.js"

/**
 * OpenAI Codex OAuth (ChatGPT Plus/Pro subscription) — authorization-code + PKCE.
 * Protocol constants match the public ChatGPT/Codex OAuth client; see
 * `pi/packages/ai/src/utils/oauth/openai-codex.ts`.
 */

export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
export const OPENAI_CALLBACK_PORT = 1455
export const OPENAI_REDIRECT_URI = `http://localhost:${OPENAI_CALLBACK_PORT}/auth/callback`
const SCOPES = "openid profile email offline_access"
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const

/** The browser authorize URL. */
export const openaiAuthorizeUrl = (pkce: Pkce): string => {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: OPENAI_REDIRECT_URI,
    scope: SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state: pkce.verifier,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "efferent",
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

const accountIdFromAccessToken = (token: string): string => {
  try {
    const parts = token.split(".")
    if (parts.length !== 3 || parts[1] === undefined) throw new Error("invalid JWT")
    const payload = JSON.parse(atob(parts[1])) as {
      readonly [JWT_CLAIM_PATH]?: { readonly chatgpt_account_id?: unknown }
    }
    const accountId = payload[JWT_CLAIM_PATH]?.chatgpt_account_id
    if (typeof accountId === "string" && accountId.length > 0) return accountId
  } catch {
    // fall through to the user-facing AuthError below
  }
  throw new Error("failed to extract ChatGPT account id from OpenAI access token")
}

const postToken = (
  body: Record<string, string>,
): Effect.Effect<OAuthTokens, AuthError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
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
        expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
        accountId: accountIdFromAccessToken(data.access_token),
      } satisfies OAuthTokens
    },
    catch: (e) =>
      new AuthError({ provider: "openai", message: `OAuth token request failed: ${String(e)}` }),
  })

/** Exchange an authorization code for tokens. */
export const exchangeOpenAiCode = (
  code: string,
  verifier: string,
): Effect.Effect<OAuthTokens, AuthError> =>
  postToken({
    grant_type: "authorization_code",
    client_id: OPENAI_CLIENT_ID,
    code,
    redirect_uri: OPENAI_REDIRECT_URI,
    code_verifier: verifier,
  })

/** Refresh an expired access token. */
export const refreshOpenAiToken = (
  refreshToken: string,
): Effect.Effect<OAuthTokens, AuthError> =>
  postToken({
    grant_type: "refresh_token",
    client_id: OPENAI_CLIENT_ID,
    refresh_token: refreshToken,
  })
