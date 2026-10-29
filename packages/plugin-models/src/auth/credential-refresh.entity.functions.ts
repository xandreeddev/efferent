import { Effect, Match, Option, Schema } from "effect"
import { AuthError } from "@xandreed/core"
import { refreshAnthropicToken } from "./anthropicOAuth.js"
import type { TokenRequestOptions } from "./anthropicOAuth.js"
import { RefreshableProvider } from "./credential-refresh.entity.js"
import type { OAuthCredential } from "./credential-refresh.entity.js"
import { refreshOpenAiCodexToken } from "./openAiCodexOAuth.js"

/** Refresh this many ms before the recorded expiry. */
export const REFRESH_SKEW_MS = 60_000

/** Whether an OAuth credential can still be used at `now`: more than the skew before its expiry. */
export const isUsableAt = (credential: OAuthCredential, now: number): boolean => credential.expires > now + REFRESH_SKEW_MS

/**
 * Refresh one provider's OAuth credential through that provider's token
 * endpoint: the same credential with the new access token, refresh token
 * and expiry (and account id, where the provider sends one). A provider
 * with no refresh flow fails with an `AuthError` naming it.
 */
export const refreshCredential = (
  provider: string,
  credential: OAuthCredential,
  options: TokenRequestOptions = {},
): Effect.Effect<OAuthCredential, AuthError> =>
  Option.match(Schema.decodeUnknownOption(RefreshableProvider)(provider), {
    onNone: () => Effect.fail(new AuthError({
      provider,
      message: `the ${provider} OAuth token expired and only anthropic and openai-codex tokens can be refreshed — sign in again or use an API key`,
    })),
    onSome: (refreshable) => Match.value(refreshable).pipe(
      Match.when("anthropic", () => refreshAnthropicToken(credential.refresh, options)),
      Match.when("openai-codex", () => refreshOpenAiCodexToken(credential.refresh, options)),
      Match.exhaustive,
    ).pipe(Effect.map((fresh): OAuthCredential => ({ ...credential, ...fresh }))),
  })
