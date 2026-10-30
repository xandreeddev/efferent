import { describe, expect, test } from "bun:test"
import { Effect, Exit, Redacted, Schema } from "effect"
import { Base64Url } from "effect/encoding"
import { Credential } from "@xandreed/core/models"
import { exchangeAnthropicCode, refreshAnthropicToken } from "./anthropicOAuth.js"
import { isSameToken, isUsableAt, REFRESH_SKEW_MS, refreshCredential } from "./credential-refresh.entity.functions.js"
import type { OAuthCredential } from "./credential-refresh.entity.js"
import { exchangeOpenAiCodexCode, refreshOpenAiCodexToken } from "./openAiCodexOAuth.js"
import type { ModelsFetch } from "../ports/models-transport.port.js"

const stale: OAuthCredential = { type: "oauth", access: Redacted.make("old-access"), refresh: Redacted.make("old-refresh"), expires: 0, accountId: "acct-1" }

/** A credential as it is stored, secrets in the clear: what a test compares (`toEqual` sees no difference between two `Redacted` values). */
const plain = Schema.encodeSync(Credential)

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
    expect(plain(fresh)).toEqual({ type: "oauth", access: "new-access", refresh: "new-refresh", expires: 1_000_000 + 3_600_000 - 300_000, accountId: "acct-1" })
    expect(requests[0]?.url).toBe("https://platform.claude.com/v1/oauth/token")
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ grant_type: "refresh_token", refresh_token: "old-refresh" })
  })

  test("refreshes an openai-codex token through the given fetch", async () => {
    const { requests, fetch } = endpoint()
    const fresh = await Effect.runPromise(refreshCredential("openai-codex", stale, { fetch, now: 5_000 }))
    expect(plain(fresh)).toMatchObject({ access: "new-access", refresh: "new-refresh", expires: 5_000 + 3_600_000 })
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
    expect(plain(fresh)).toMatchObject({ type: "oauth", access: "new-access", refresh: "old-refresh" })
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

  test.each(refreshable)("%s: the request carries the refresh token in the clear, and the refreshed credential holds its tokens Redacted", async (provider) => {
    const { requests, fetch } = endpoint()
    const fresh = await Effect.runPromise(refreshCredential(provider, stale, { fetch, now: 1_000 }))
    expect(requests[0]?.body).toContain("old-refresh")
    expect([Redacted.isRedacted(fresh.access), Redacted.isRedacted(fresh.refresh)]).toEqual([true, true])
    expect(`${String(fresh.access)} ${JSON.stringify(fresh)}`).not.toContain("new-")
  })

  test("the same token is told by its values, not by the Redacted wrappers holding them", () => {
    const copy: OAuthCredential = { ...stale, access: Redacted.make("old-access"), refresh: Redacted.make("old-refresh") }
    expect(isSameToken(copy, stale)).toBe(true)
    expect(isSameToken({ ...copy, access: Redacted.make("other-access") }, stale)).toBe(false)
    expect(isSameToken({ ...copy, refresh: Redacted.make("other-refresh") }, stale)).toBe(false)
    expect(isSameToken({ ...copy, expires: 1 }, stale)).toBe(false)
    expect(isSameToken({ type: "api_key", key: Redacted.make("old-access") }, stale)).toBe(false)
  })

  test("a token is usable until the skew before its expiry", () => {
    expect(isUsableAt({ ...stale, expires: 10_000 + REFRESH_SKEW_MS + 1 }, 10_000)).toBe(true)
    expect(isUsableAt({ ...stale, expires: 10_000 + REFRESH_SKEW_MS }, 10_000)).toBe(false)
  })
})

describe("the sign-in and refresh helpers", () => {
  const signIns = [["anthropic", exchangeAnthropicCode], ["openai-codex", exchangeOpenAiCodexCode]] as const
  const refreshes = [["anthropic", refreshAnthropicToken], ["openai-codex", refreshOpenAiCodexToken]] as const

  test.each(signIns)("%s: a sign-in's tokens are Redacted from the token response on, ready for AuthStore.set as they are", async (_provider, exchange) => {
    const { fetch } = endpoint()
    const tokens = await Effect.runPromise(exchange("code", "verifier", { fetch, now: 1_000 }))
    expect([Redacted.isRedacted(tokens.access), Redacted.isRedacted(tokens.refresh)]).toEqual([true, true])
    expect(`${String(tokens.access)} ${String(tokens.refresh)} ${JSON.stringify(tokens)}`).not.toContain("new-")
    expect(plain({ type: "oauth", ...tokens })).toMatchObject({ type: "oauth", access: "new-access", refresh: "new-refresh" })
  })

  test.each(refreshes)("%s: a refresh takes the refresh token Redacted and unwraps it only into the request", async (_provider, refresh) => {
    const { requests, fetch } = endpoint({ access_token: "new-access", expires_in: 3600 })
    const tokens = await Effect.runPromise(refresh(Redacted.make("old-refresh"), { fetch, now: 1_000 }))
    expect(requests[0]?.body).toContain("old-refresh")
    expect([Redacted.value(tokens.access), Redacted.value(tokens.refresh)]).toEqual(["new-access", "old-refresh"])
    expect(JSON.stringify(tokens)).not.toContain("old-refresh")
  })

  /** A token endpoint that refuses every request and echoes the whole request back in its body. */
  const echoing = (status: number): ModelsFetch => (_input, init) =>
    Promise.resolve(new Response(`invalid_grant: ${String(init?.body)}`, { status }))

  test.each(refreshes)("%s: a refused refresh says the status and the start of the body, never the refresh token it sent", async (_provider, refresh) => {
    const failure = await Effect.runPromise(Effect.flip(refresh(Redacted.make("old-refresh-secret"), { fetch: echoing(400), now: 1_000 })))
    expect(failure.message).toContain("status 400: invalid_grant: ")
    expect(failure.message).toContain("<redacted>")
    expect(`${failure.message} ${JSON.stringify(failure)}`).not.toContain("old-refresh-secret")
  })

  test.each(signIns)("%s: a refused sign-in never quotes the code or the verifier it sent", async (_provider, exchange) => {
    const failure = await Effect.runPromise(Effect.flip(exchange("code-secret", "verifier-secret", { fetch: echoing(401), now: 1_000 })))
    expect(failure.message).toContain("status 401: invalid_grant: ")
    expect(`${failure.message} ${JSON.stringify(failure)}`).not.toMatch(/code-secret|verifier-secret/)
  })

  test("an openai-codex sign-in reads the account id from its Redacted access token", async () => {
    const access = `header.${Base64Url.encode(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" } }))}.signature`
    const { fetch } = endpoint({ access_token: access, refresh_token: "new-refresh", expires_in: 3600 })
    const tokens = await Effect.runPromise(exchangeOpenAiCodexCode("code", "verifier", { fetch, now: 1_000 }))
    expect(tokens.accountId).toBe("acct-9")
    expect(Redacted.value(tokens.access)).toBe(access)
  })
})
