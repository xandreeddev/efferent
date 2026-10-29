import { createHash } from "node:crypto"
import { Clock, Effect, Option } from "effect"
import { AuthError } from "@xandreed/core"
import type { ModelsFetch } from "../ports/models-transport.port.js"
import { redactCredentials } from "../transport/http-proxy.entity.functions.js"
import { decodeTokenResponse } from "./token-response.entity.functions.js"

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

/**
 * How one token request is made, for both subscription providers. `fetch`
 * replaces the global fetch (a test stub, or a `ModelsTransport`'s fetch, so
 * the request goes through the models plugin's proxy); `now` is
 * the time the new token's expiry is counted from, in epoch ms (default: the
 * Effect `Clock`).
 */
export interface TokenRequestOptions {
  readonly fetch?: ModelsFetch
  readonly now?: number
}

/** The time a token's expiry is counted from: the caller's, or the Effect Clock's. */
export const tokenTime = (options: TokenRequestOptions): Effect.Effect<number> =>
  options.now === undefined ? Clock.currentTimeMillis : Effect.succeed(options.now)

/**
 * One token-endpoint POST; refresh and exchange share it verbatim.
 * `previous` is the refresh token a refresh sends, kept when the response
 * does not rotate it.
 */
const postToken = (
  body: Record<string, string>,
  stage: string,
  options: TokenRequestOptions,
  previous: Option.Option<string>,
): Effect.Effect<RefreshedTokens, AuthError> => {
  const fail = oauthError(stage)
  return Effect.tryPromise({
    try: async () => {
      const res = await (options.fetch ?? fetch)(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      })
      return { ok: res.ok, status: res.status, text: await res.text() }
    },
    catch: (e) => fail(redactCredentials(String(e))),
  }).pipe(
    Effect.filterOrFail(
      (res) => res.ok,
      (res) => fail(`status ${res.status}: ${res.text.slice(0, 200)}`),
    ),
    Effect.flatMap((res) => decodeTokenResponse(res.text, previous).pipe(Effect.mapError(fail))),
    Effect.flatMap((issued) => Effect.map(tokenTime(options), (now) => ({
      access: issued.access,
      refresh: issued.refresh,
      expires: now + issued.lifetimeMs - 5 * 60 * 1000,
    }))),
  )
}

/** Refresh an expired (or near-expiry) access token. */
export const refreshAnthropicToken = (
  refreshToken: string,
  options: TokenRequestOptions = {},
): Effect.Effect<RefreshedTokens, AuthError> =>
  postToken(
    {
      grant_type: "refresh_token",
      client_id: ANTHROPIC_CLIENT_ID,
      refresh_token: refreshToken,
    },
    "token refresh",
    options,
    Option.some(refreshToken),
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

/** Generate a PKCE verifier (32 bytes of the platform's cryptographic generator) + its S256 challenge. */
export const generatePkce: Effect.Effect<Pkce> = Effect.sync(() => {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)))
  return { verifier, challenge: base64url(new Uint8Array(createHash("sha256").update(verifier).digest())) }
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
  options: TokenRequestOptions = {},
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
    options,
    Option.none(),
  )

export interface AuthRedirect {
  readonly code: Option.Option<string>
  readonly state: Option.Option<string>
}

const fromNullableTrimmed = (value: string | null | undefined): Option.Option<string> =>
  Option.filter(Option.fromNullishOr(value), (v) => v.trim().length > 0)

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
