import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { exchangeAnthropicCode } from "./anthropicOAuth.js"
import { isUsableAt, REFRESH_SKEW_MS, refreshCredential } from "./credential-refresh.entity.functions.js"
import type { OAuthCredential } from "./credential-refresh.entity.js"
import { exchangeOpenAiCodexCode } from "./openAiCodexOAuth.js"

const stale: OAuthCredential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0, accountId: "acct-1" }

/** A token endpoint stub: records the URL and body, answers with `answer` (fixed tokens by default). */
const endpoint = (answer: unknown = { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }) => {
  const requests: Array<{ url: string; body: string }> = []
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: String(init?.body) })
    return typeof answer === "string" ? new Response(answer) : Response.json(answer)
  }, { preconnect: () => {} })
  return { requests, fetch }
}

const refreshable: Array<"anthropic" | "openai-codex"> = ["anthropic", "openai-codex"]

describe("refreshCredential", () => {
  test("refreshes an anthropic token through the given fetch, counting the expiry from `now`", async () => {
    const { requests, fetch } = endpoint()
    const fresh = await Effect.runPromise(refreshCredential("anthropic", stale, { fetch, now: 1_000_000 }))
    expect(fresh).toEqual({ type: "oauth", access: "new-access", refresh: "new-refresh", expires: 1_000_000 + 3_600_000 - 300_000, accountId: "acct-1" })
    expect(requests[0]?.url).toBe("https://platform.claude.com/v1/oauth/token")
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" })
  })

  test("refreshes an openai-codex token through the given fetch", async () => {
    const { requests, fetch } = endpoint()
    const fresh = await Effect.runPromise(refreshCredential("openai-codex", stale, { fetch, now: 5_000 }))
    expect(fresh).toMatchObject({ access: "new-access", refresh: "new-refresh", expires: 5_000 + 3_600_000 })
    expect(requests[0]?.url).toBe("https://auth.openai.com/oauth/token")
    expect(new URLSearchParams(requests[0]!.body).get("refresh_token")).toBe("old-refresh")
  })

  test("a provider with no refresh flow fails with an AuthError naming it, and sends nothing", async () => {
    const { requests, fetch } = endpoint()
    const exit = await Effect.runPromiseExit(refreshCredential("acme", stale, { fetch }))
    expect(Exit.isFailure(exit) && JSON.stringify(exit)).toContain("\"provider\":\"acme\"")
    expect(requests).toEqual([])
  })

  test.each(refreshable)("%s: a refresh that does not rotate the refresh token keeps the one it sent", async (provider) => {
    const { fetch } = endpoint({ access_token: "new-access", expires_in: 3600 })
    const fresh = await Effect.runPromise(refreshCredential(provider, stale, { fetch, now: 1_000 }))
    expect(fresh).toMatchObject({ type: "oauth", access: "new-access", refresh: "old-refresh" })
    expect(Number.isFinite(fresh.expires) && fresh.expires > 1_000).toBe(true)
  })

  test.each(refreshable)("%s: a token response without a usable token or lifetime fails, and never quotes the response", async (provider) => {
    const answers: ReadonlyArray<unknown> = [
      { refresh_token: "leaked-refresh", expires_in: 3600 },
      { access_token: "leaked-access", refresh_token: "leaked-refresh" },
      { access_token: "leaked-access", refresh_token: "leaked-refresh", expires_in: 0 },
      { access_token: "leaked-access", refresh_token: "leaked-refresh", expires_in: "3600" },
      "leaked-access is not JSON",
    ]
    const failures = await Effect.runPromise(Effect.forEach(answers, (answer) => Effect.flip(refreshCredential(provider, stale, { fetch: endpoint(answer).fetch, now: 1_000 }))))
    expect(failures.map((failure) => [failure._tag, failure.provider])).toEqual(answers.map(() => ["AuthError", provider]))
    expect(failures.map((failure) => failure.message).join("\n")).not.toContain("leaked")
  })

  test("a code exchange whose response has no refresh token fails: the login could never be refreshed", async () => {
    const { fetch } = endpoint({ access_token: "new-access", expires_in: 3600 })
    const failures = await Effect.runPromise(Effect.all([
      Effect.flip(exchangeAnthropicCode("code", "verifier", { fetch })),
      Effect.flip(exchangeOpenAiCodexCode("code", "verifier", { fetch })),
    ]))
    expect(failures.map((failure) => failure.message)).toEqual([
      "OAuth code exchange failed: the token response did not hold a refresh token",
      "OAuth code exchange failed: the token response did not hold a refresh token",
    ])
  })

  test("a token is usable until the skew before its expiry", () => {
    expect(isUsableAt({ ...stale, expires: 10_000 + REFRESH_SKEW_MS + 1 }, 10_000)).toBe(true)
    expect(isUsableAt({ ...stale, expires: 10_000 + REFRESH_SKEW_MS }, 10_000)).toBe(false)
  })
})
