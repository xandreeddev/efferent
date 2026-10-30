import { Effect, Result, Option, Redacted, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { AuthError } from "../ports/auth-store.port.js"
import { generatePkce, tokenTime } from "./anthropicOAuth.js"
import type { TokenRequestOptions } from "./anthropicOAuth.js"
import { redactCredentials } from "../transport/http-proxy.entity.functions.js"
import { decodeTokenResponse, tokenRefusalText } from "./token-response.entity.functions.js"

/** ChatGPT Plus/Pro OAuth protocol used by the OpenAI Codex subscription. */
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
/** The originator registered with `OPENAI_CODEX_CLIENT_ID`. The authorize
 * request, the token and the subscription transports must all send it: the
 * backend keys model entitlement to the client/originator pair. */
export const OPENAI_CODEX_ORIGINATOR = "pi"
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
const TOKEN_URL = "https://auth.openai.com/oauth/token"
export const OPENAI_CODEX_CALLBACK_PORT = 1455
export const OPENAI_CODEX_CALLBACK_PATH = "/auth/callback"
export const OPENAI_CODEX_REDIRECT_URI = `http://localhost:${OPENAI_CODEX_CALLBACK_PORT}${OPENAI_CODEX_CALLBACK_PATH}`
const SCOPE = "openid profile email offline_access"
const ACCOUNT_CLAIM = "https://api.openai.com/auth"

/**
 * The tokens a sign-in or a refresh grants, `Redacted` from the token response on, and the account id read from the access token.
 *
 * @public
 */
export interface OpenAiCodexTokens {
  readonly access: Redacted.Redacted<string>
  readonly refresh: Redacted.Redacted<string>
  readonly expires: number
  readonly accountId?: string
}

/** @public */
export interface OpenAiCodexOAuthBegin {
  readonly verifier: string
  readonly state: string
  readonly authorizeUrl: string
  readonly callbackPort: number
  readonly callbackPath: string
}

const oauthError = (stage: string, detail: string): AuthError =>
  new AuthError({ provider: "openai-codex", message: `OAuth ${stage} failed: ${detail}` })

/** The access token's claims this client reads: the subscription's account id, under OpenAI's auth claim. */
const AccessTokenClaims = Schema.Struct({
  [ACCOUNT_CLAIM]: Schema.optionalKey(Schema.Struct({ chatgpt_account_id: Schema.optionalKey(Schema.NonEmptyString) })),
})
const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(AccessTokenClaims))

/** A JWT payload segment's claims: base64url text holding them; none for anything else. */
const claimsOf = (segment: string): Option.Option<typeof AccessTokenClaims.Type> =>
  Option.flatMap(Result.getSuccess(Base64Url.decodeString(segment)), decodeClaims)

/** Extract the subscription account lane without exposing the token. */
export const openAiCodexAccountId = (accessToken: string): Option.Option<string> =>
  Option.flatMap(
    Option.flatMap(Option.fromNullishOr(accessToken.split(".")[1]), claimsOf),
    (claims) => Option.fromNullishOr(claims[ACCOUNT_CLAIM]?.chatgpt_account_id),
  )

/**
 * One token-endpoint POST; `body` is the form as sent, its secrets in the
 * clear. `previous` is the refresh token a refresh sends, kept when the
 * response does not rotate it.
 */
const postToken = (
  body: Record<string, string>,
  stage: string,
  options: TokenRequestOptions,
  previous: Option.Option<Redacted.Redacted<string>>,
): Effect.Effect<OpenAiCodexTokens, AuthError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await (options.fetch ?? fetch)(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body),
        signal: AbortSignal.timeout(30_000),
      })
      return { ok: response.ok, status: response.status, text: await response.text() }
    },
    catch: (error) => oauthError(stage, redactCredentials(String(error))),
  }).pipe(
    Effect.filterOrFail(
      (response) => response.ok,
      (response) => oauthError(stage, tokenRefusalText(response.status, response.text, body)),
    ),
    Effect.flatMap((response) => decodeTokenResponse(response.text, previous).pipe(Effect.mapError((reason) => oauthError(stage, reason)))),
    Effect.flatMap((issued) => Effect.map(tokenTime(options), (now) => ({
      access: issued.access,
      refresh: issued.refresh,
      expires: now + issued.lifetimeMs,
      ...Option.match(openAiCodexAccountId(Redacted.value(issued.access)), { onNone: () => ({}), onSome: (accountId) => ({ accountId }) }),
    }))),
  )

/** @public */
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
      originator: OPENAI_CODEX_ORIGINATOR,
    }).forEach(([key, value]) => url.searchParams.set(key, value))
    return { verifier: pkce.verifier, state, authorizeUrl: url.toString(), callbackPort: OPENAI_CODEX_CALLBACK_PORT, callbackPath: OPENAI_CODEX_CALLBACK_PATH }
  })

/**
 * Exchange the authorization code for tokens, `Redacted` (ready for `AuthStore.set`).
 *
 * @public
 */
export const exchangeOpenAiCodexCode = (
  code: string,
  verifier: string,
  options: TokenRequestOptions = {},
): Effect.Effect<OpenAiCodexTokens, AuthError> =>
  postToken({ grant_type: "authorization_code", client_id: OPENAI_CODEX_CLIENT_ID, code, code_verifier: verifier, redirect_uri: OPENAI_CODEX_REDIRECT_URI }, "code exchange", options, Option.none())

/**
 * Refresh an expired (or near-expiry) access token; the refresh token is unwrapped only into the request form.
 *
 * @public
 */
export const refreshOpenAiCodexToken = (
  refreshToken: Redacted.Redacted<string>,
  options: TokenRequestOptions = {},
): Effect.Effect<OpenAiCodexTokens, AuthError> =>
  postToken({ grant_type: "refresh_token", refresh_token: Redacted.value(refreshToken), client_id: OPENAI_CODEX_CLIENT_ID }, "token refresh", options, Option.some(refreshToken))
