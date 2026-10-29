import { Effect, Option, Schema } from "effect"
import { TokenResponse } from "./token-response.entity.js"
import type { IssuedTokens } from "./token-response.entity.js"

const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse))

/**
 * Decode a token endpoint's answer. `previous` is the refresh token a
 * refresh sent: a response without one keeps it. A code exchange sends
 * none, so its response must carry a refresh token. A response that is not
 * JSON, has no access token or no lifetime above zero seconds fails with a
 * reason that never quotes the response, which holds secrets.
 */
export const decodeTokenResponse = (text: string, previous: Option.Option<string>): Effect.Effect<IssuedTokens, string> =>
  decodeResponse(text).pipe(
    Effect.mapError(() => "the token response did not hold an access token and its lifetime (expires_in, in seconds, above 0)"),
    Effect.flatMap((response) => Option.match(Option.orElse(Option.filter(response.refresh_token, (token) => token.length > 0), () => previous), {
      onNone: () => Effect.fail("the token response did not hold a refresh token"),
      onSome: (refresh) => Effect.succeed({ access: response.access_token, refresh, lifetimeMs: response.expires_in * 1000 }),
    })),
  )
