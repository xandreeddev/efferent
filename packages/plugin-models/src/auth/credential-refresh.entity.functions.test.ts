import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { isUsableAt, REFRESH_SKEW_MS, refreshCredential } from "./credential-refresh.entity.functions.js"
import type { OAuthCredential } from "./credential-refresh.entity.js"

const stale: OAuthCredential = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 0, accountId: "acct-1" }

/** A token endpoint stub: records the URL and body, answers with fixed tokens. */
const endpoint = () => {
  const requests: Array<{ url: string; body: string }> = []
  const fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), body: String(init?.body) })
    return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
  }, { preconnect: () => {} })
  return { requests, fetch }
}

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

  test("a token is usable until the skew before its expiry", () => {
    expect(isUsableAt({ ...stale, expires: 10_000 + REFRESH_SKEW_MS + 1 }, 10_000)).toBe(true)
    expect(isUsableAt({ ...stale, expires: 10_000 + REFRESH_SKEW_MS }, 10_000)).toBe(false)
  })
})
