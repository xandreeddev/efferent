import { Effect, Option, Redacted, Schema } from "effect"
import { TokenResponse } from "./token-response.entity.js"
import type { IssuedTokens } from "./token-response.entity.js"

const decodeResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(TokenResponse))

/** Whether a response's refresh token holds anything: an empty one is no token. */
const isNonEmpty = (token: Redacted.Redacted<string>): boolean => Redacted.value(token).length > 0

/** The fields of a token request that hold a secret: a refresh token, an authorization code and its PKCE verifier. */
const SECRET_FIELDS: ReadonlyArray<string> = ["refresh_token", "code", "code_verifier"]

/** How much of a refused token request's response body an error quotes. */
export const TOKEN_ERROR_BODY_CHARS = 200

/**
 * What an error says of a token endpoint's refusal: its status and the
 * start of its body, every secret the request sent (`SECRET_FIELDS` of
 * `sent`) replaced by `<redacted>` first, so an endpoint that echoes the
 * request never puts a token into an error, a log or the model's view.
 */
export const tokenRefusalText = (status: number, body: string, sent: Readonly<Record<string, string>>): string => {
  const secrets = SECRET_FIELDS.flatMap((field) => Option.toArray(Option.filter(Option.fromNullishOr(sent[field]), (value) => value.length > 0)))
  const redacted = secrets.reduce((text, secret) => text.replaceAll(secret, "<redacted>"), body)
  return `status ${status}: ${redacted.slice(0, TOKEN_ERROR_BODY_CHARS)}`
}

/**
 * Decode a token endpoint's answer, its tokens `Redacted`. `previous` is
 * the refresh token a refresh sent: a response without one keeps it. A code
 * exchange sends none, so its response must carry a refresh token. A
 * response that is not JSON, has no access token or no lifetime above zero
 * seconds fails with a reason that never quotes the response, which holds
 * secrets.
 */
export const decodeTokenResponse = (
  text: string,
  previous: Option.Option<Redacted.Redacted<string>>,
): Effect.Effect<IssuedTokens, string> =>
  decodeResponse(text).pipe(
    Effect.mapError(() => "the token response did not hold an access token and its lifetime (expires_in, in seconds, above 0)"),
    Effect.flatMap((response) => Option.match(Option.orElse(Option.filter(response.refresh_token, isNonEmpty), () => previous), {
      onNone: () => Effect.fail("the token response did not hold a refresh token"),
      onSome: (refresh) => Effect.succeed({ access: response.access_token, refresh, lifetimeMs: response.expires_in * 1000 }),
    })),
  )
