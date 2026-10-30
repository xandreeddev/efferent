import { describe, expect, test } from "bun:test"
import { Effect, Option, Redacted } from "effect"
import type { IssuedTokens } from "./token-response.entity.js"
import { decodeTokenResponse, tokenRefusalText } from "./token-response.entity.functions.js"

const decode = (answer: unknown, previous: Option.Option<Redacted.Redacted<string>> = Option.none()) =>
  decodeTokenResponse(JSON.stringify(answer), previous)

/** The values a grant holds: what a test compares (`toEqual` sees no difference between two `Redacted` values). */
const values = (issued: IssuedTokens) => ({ access: Redacted.value(issued.access), refresh: Redacted.value(issued.refresh), lifetimeMs: issued.lifetimeMs })

describe("decodeTokenResponse", () => {
  test("the tokens are Redacted from the response on: they print and serialize as <redacted>", async () => {
    const issued = await Effect.runPromise(decode({ access_token: "issued-access", refresh_token: "issued-refresh", expires_in: 3600 }))
    expect(values(issued)).toEqual({ access: "issued-access", refresh: "issued-refresh", lifetimeMs: 3_600_000 })
    expect([Redacted.isRedacted(issued.access), Redacted.isRedacted(issued.refresh)]).toEqual([true, true])
    expect(`${String(issued.access)} ${String(issued.refresh)} ${JSON.stringify(issued)}`).not.toContain("issued-")
  })

  test("a response without a refresh token, or with an empty one, keeps the one the refresh sent", async () => {
    const previous = Option.some(Redacted.make("sent-refresh"))
    const kept = await Effect.runPromise(Effect.all([
      decode({ access_token: "issued-access", expires_in: 60 }, previous),
      decode({ access_token: "issued-access", refresh_token: "", expires_in: 60 }, previous),
    ], { concurrency: 1 }))
    expect(kept.map(values)).toEqual([
      { access: "issued-access", refresh: "sent-refresh", lifetimeMs: 60_000 },
      { access: "issued-access", refresh: "sent-refresh", lifetimeMs: 60_000 },
    ])
  })

  test("a response with an empty access token fails, and never quotes the response", async () => {
    const failure = await Effect.runPromise(Effect.flip(decode({ access_token: "", refresh_token: "leaked-refresh", expires_in: 60 })))
    expect(failure).toBe("the token response did not hold an access token and its lifetime (expires_in, in seconds, above 0)")
  })
})

describe("tokenRefusalText", () => {
  test("the status and the body's start, each secret the request sent replaced first, so a cut never leaves part of one", () => {
    const sent = { grant_type: "refresh_token", client_id: "client", refresh_token: "rt-secret", code: "", code_verifier: "v-secret" }
    expect(tokenRefusalText(400, "bad rt-secret and v-secret for client", sent)).toBe("status 400: bad <redacted> and <redacted> for client")
    expect(tokenRefusalText(500, `${"x".repeat(195)}rt-secret`, sent)).toBe(`status 500: ${"x".repeat(195)}<reda`)
    expect(tokenRefusalText(503, "y".repeat(300), {})).toBe(`status 503: ${"y".repeat(200)}`)
  })
})
