import { Effect } from "effect"
import { AuthError } from "@xandreed/engine"

/**
 * Anthropic OAuth (Claude Pro/Max subscription) — the refresh half of the
 * protocol. Constants match the public Claude Code OAuth client (the client
 * id is not a secret). The interactive authorize/exchange flow is a driver
 * concern; the store only needs refresh.
 */

export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

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

const refreshError = (detail: string): AuthError =>
  new AuthError({
    provider: "anthropic",
    message: `OAuth token refresh failed: ${detail}`,
  })

/** Refresh an expired (or near-expiry) access token. */
export const refreshAnthropicToken = (
  refreshToken: string,
): Effect.Effect<RefreshedTokens, AuthError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: ANTHROPIC_CLIENT_ID,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      return { ok: res.ok, status: res.status, text: await res.text() }
    },
    catch: (e) => refreshError(String(e)),
  }).pipe(
    Effect.filterOrFail(
      (res) => res.ok,
      (res) => refreshError(`status ${res.status}: ${res.text.slice(0, 200)}`),
    ),
    Effect.flatMap((res) =>
      Effect.try({
        try: () =>
          JSON.parse(res.text) as {
            access_token: string
            refresh_token: string
            expires_in: number
          },
        catch: () => refreshError("the token response was not JSON"),
      }),
    ),
    Effect.map((data) => ({
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
    })),
  )
