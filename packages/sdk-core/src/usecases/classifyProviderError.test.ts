import { describe, expect, test } from "bun:test"
import { AiError } from "@effect/ai"
import { Option } from "effect"
import { classifyProviderError } from "./classifyProviderError.js"

// Real forensic fixtures: every class below anonymously killed nodes in the
// July run data before the taxonomy existed.

const request = {
  method: "POST" as const,
  url: "https://example.test/chat",
  urlParams: [] as Array<[string, string]>,
  hash: Option.none<string>(),
  headers: {} as Record<string, string>,
}

const httpError = (
  status: number,
  headers: Record<string, string> = {},
  body = "",
): AiError.HttpResponseError =>
  new AiError.HttpResponseError({
    module: "Test",
    method: "chat",
    reason: "StatusCode",
    request,
    response: { status, headers },
    body,
    description: "",
  })

const unknown = (description: string): AiError.UnknownError =>
  new AiError.UnknownError({ module: "Test", method: "chat", description })

const NOW = 1_700_000_000_000

describe("classifyProviderError — the provider-defect taxonomy", () => {
  test("transient: plain 429 / retryable 5xx / transport / fetch timeout", () => {
    expect(classifyProviderError(httpError(429), NOW)).toBe("transient")
    expect(classifyProviderError(httpError(503), NOW)).toBe("transient")
    expect(
      classifyProviderError(
        new AiError.HttpRequestError({
          module: "T",
          method: "chat",
          reason: "Transport",
          request,
        }),
        NOW,
      ),
    ).toBe("transient")
    expect(classifyProviderError(unknown("OpenCode.readStream: TimeoutError: The operation timed out."), NOW)).toBe(
      "transient",
    )
    // The router's empty-body rejection — HTTP 200, zero content, the
    // "turn N: unknown · 0 tok" forensic class. Degraded gateway ⇒ retry.
    expect(
      classifyProviderError(
        unknown("empty model response from opencode:kimi-k2.6 (no text, no tool calls)"),
        NOW,
      ),
    ).toBe("transient")
  })

  test("quota: the opencode daily-quota 429 (multi-hour Retry-After) — the value that must NOT retry in place", () => {
    // "48489" seconds ≈ 13.5h until the midnight-UTC reset.
    expect(classifyProviderError(httpError(429, { "retry-after": "48489" }), NOW)).toBe("quota")
    // …while a short server-suggested wait stays transient.
    expect(classifyProviderError(httpError(429, { "retry-after": "20" }), NOW)).toBe("transient")
  })

  test("quota: CreditsError / usage-limit bodies and 402", () => {
    expect(classifyProviderError(unknown("CreditsError: Insufficient balance"), NOW)).toBe("quota")
    expect(
      classifyProviderError(httpError(429, {}, '{"error":"GoUsageLimitError: Weekly usage limit reached. Resets in 7hr 49min"}'), NOW),
    ).toBe("quota")
    expect(classifyProviderError(httpError(402), NOW)).toBe("quota")
  })

  test("config: the kimi invalid-thinking 400 and the anthropic ?beta=true 404", () => {
    expect(
      classifyProviderError(
        httpError(400, {}, "invalid thinking: only type=enabled is allowed for this model"),
        NOW,
      ),
    ).toBe("config")
    expect(classifyProviderError(httpError(404), NOW)).toBe("config")
  })

  test("auth: 401/403 — never fails over, surfaces with the :login hint", () => {
    expect(classifyProviderError(httpError(401), NOW)).toBe("auth")
    expect(classifyProviderError(httpError(403), NOW)).toBe("auth")
  })

  test("model: a response-decode MalformedOutput (the loop owns recovery)", () => {
    expect(
      classifyProviderError(
        new AiError.MalformedOutput({ module: "T", method: "decode", description: "bad union" }),
        NOW,
      ),
    ).toBe("model")
  })

  test("non-AiError / unrecognized ⇒ undefined (no false classification)", () => {
    expect(classifyProviderError(new Error("boom"), NOW)).toBeUndefined()
    expect(classifyProviderError(unknown("something novel"), NOW)).toBeUndefined()
  })
})
