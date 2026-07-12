import { Effect, Either, Option } from "effect"
import { AuthError } from "@xandreed/engine"
import { generatePkce } from "./anthropicOAuth.js"

/** ChatGPT Plus/Pro OAuth protocol used by the OpenAI Codex subscription. */
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
export const OPENAI_CODEX_CALLBACK_PORT = 1455
export const OPENAI_CODEX_CALLBACK_PATH = "/auth/callback"
export const OPENAI_CODEX_REDIRECT_URI = `http://localhost:${OPENAI_CODEX_CALLBACK_PORT}${OPENAI_CODEX_CALLBACK_PATH}`
const SCOPE = "openid profile email offline_access"
const ACCOUNT_CLAIM = "https://api.openai.com/auth"

export interface OpenAiCodexTokens {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly accountId?: string
}

export interface OpenAiCodexOAuthBegin {
  readonly verifier: string
  readonly state: string
  readonly authorizeUrl: string
  readonly callbackPort: number
  readonly callbackPath: string
}

const oauthError = (stage: string, detail: string): AuthError =>
  new AuthError({ provider: "openai-codex", message: `OAuth ${stage} failed: ${detail}` })

const base64UrlJson = (segment: string): unknown => {
  const normalized = segment.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
  return JSON.parse(atob(padded)) as unknown
}

/** Extract the subscription account lane without exposing the token. */
export const openAiCodexAccountId = (accessToken: string): Option.Option<string> => {
  const segment = accessToken.split(".")[1]
  return Option.flatMap(
    Option.fromNullable(segment),
    (encoded) => Option.flatMap(
      Either.getRight(Either.try(() => base64UrlJson(encoded) as Record<string, unknown>)),
      (payload) => {
        const claim = payload[ACCOUNT_CLAIM]
        if (typeof claim !== "object" || claim === null) return Option.none<string>()
        const accountId = (claim as Record<string, unknown>)["chatgpt_account_id"]
        return Option.filter(Option.fromNullable(typeof accountId === "string" ? accountId : undefined), (value) => value.length > 0)
      },
    ),
  )
}

const postToken = (
  body: Record<string, string>,
  stage: string,
): Effect.Effect<OpenAiCodexTokens, AuthError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(30_000),
      })
      return { ok: response.ok, status: response.status, text: await response.text() }
    },
    catch: (error) => oauthError(stage, String(error)),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) => oauthError(stage, `status ${response.status}: ${response.text.slice(0, 200)}`),
    ),
    Effect.flatMap((response) =>
      Effect.try({
        try: () => JSON.parse(response.text) as { access_token: string; refresh_token: string; expires_in: number },
        catch: () => oauthError(stage, "the token response was not JSON"),
      }),
    ),
    Effect.filterOrFail(
      (token) => typeof token.access_token === "string" && typeof token.refresh_token === "string" && typeof token.expires_in === "number",
      () => oauthError(stage, "the token response omitted required fields"),
    ),
    Effect.map((token) => ({
      access: token.access_token,
      refresh: token.refresh_token,
      expires: Date.now() + token.expires_in * 1000,
      ...Option.match(openAiCodexAccountId(token.access_token), { onNone: () => ({}), onSome: (accountId) => ({ accountId }) }),
    })),
  )

export const beginOpenAiCodexOAuth: Effect.Effect<OpenAiCodexOAuthBegin> =
  Effect.gen(function* () {
    const pkce = yield* generatePkce
    const stateBytes = new Uint8Array(16)
    crypto.getRandomValues(stateBytes)
    const state = Array.from(stateBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    const url = new URL(AUTHORIZE_URL)
    Object.entries({
      response_type: "code",
      client_id: OPENAI_CODEX_CLIENT_ID,
      redirect_uri: OPENAI_CODEX_REDIRECT_URI,
      scope: SCOPE,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      state,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      // This flow uses Pi's registered OAuth client id, so the authorize
      // request must identify the same client originator as the token and
      // subscription transports.
      originator: "pi",
    }).forEach(([key, value]) => url.searchParams.set(key, value))
    return { verifier: pkce.verifier, state, authorizeUrl: url.toString(), callbackPort: OPENAI_CODEX_CALLBACK_PORT, callbackPath: OPENAI_CODEX_CALLBACK_PATH }
  })

export const exchangeOpenAiCodexCode = (
  code: string,
  verifier: string,
): Effect.Effect<OpenAiCodexTokens, AuthError> =>
  postToken({ grant_type: "authorization_code", client_id: OPENAI_CODEX_CLIENT_ID, code, code_verifier: verifier, redirect_uri: OPENAI_CODEX_REDIRECT_URI }, "code exchange")

export const refreshOpenAiCodexToken = (
  refreshToken: string,
): Effect.Effect<OpenAiCodexTokens, AuthError> =>
  postToken({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: OPENAI_CODEX_CLIENT_ID }, "token refresh")
