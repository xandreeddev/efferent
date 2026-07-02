import { describe, expect, it } from "bun:test"
import { AiError } from "@effect/ai"
import { Option } from "effect"
import {
  isEmptyResponseContent,
  planQuotaPark,
  QUOTA_PARK_CEILING_MS,
  quotaResetDelayMs,
} from "./router.js"

// The forensic class this guards: the opencode gateway under load answers
// HTTP 200 with an empty body and `finishReason: "unknown"` — the loop read
// that as a completed turn ("turn 24: unknown · 0 tok"), so agents "finished"
// mid-thought and recorded a mid-sentence line as their deliverable.
describe("isEmptyResponseContent", () => {
  it("flags a response with no parts at all", () => {
    expect(isEmptyResponseContent([])).toBe(true)
  })

  it("flags a response whose only parts carry nothing (finish/usage, blank text)", () => {
    expect(isEmptyResponseContent([{ type: "finish" }])).toBe(true)
    expect(isEmptyResponseContent([{ type: "text", text: "" }, { type: "finish" }])).toBe(true)
    expect(isEmptyResponseContent([{ type: "text", text: "   " }])).toBe(true)
  })

  it("accepts real text", () => {
    expect(isEmptyResponseContent([{ type: "text", text: "done." }])).toBe(false)
  })

  it("accepts a tool call (even with no text)", () => {
    expect(isEmptyResponseContent([{ type: "tool-call" }, { type: "finish" }])).toBe(false)
  })

  it("accepts reasoning-only responses", () => {
    expect(isEmptyResponseContent([{ type: "reasoning", text: "thinking…" }])).toBe(false)
  })
})

const NOW = 1_750_000_000_000

const quotaError = (headers: Record<string, string>): AiError.HttpResponseError =>
  new AiError.HttpResponseError({
    module: "Test",
    method: "chat",
    reason: "StatusCode",
    request: {
      method: "POST" as const,
      url: "https://example.test/chat",
      urlParams: [] as Array<[string, string]>,
      hash: Option.none<string>(),
      headers: {} as Record<string, string>,
    },
    response: { status: 429, headers },
    body: "",
    description: "",
  })

describe("quotaResetDelayMs", () => {
  it("reads the opencode daily-quota Retry-After (seconds until midnight UTC)", () => {
    expect(quotaResetDelayMs(quotaError({ "retry-after": "48489" }), NOW)).toBe(48_489_000)
  })

  it("reads Anthropic's unified-reset header (epoch seconds — the session cap)", () => {
    const resetEpochSecs = Math.round(NOW / 1000) + 3_600 // 1h away
    expect(
      quotaResetDelayMs(
        quotaError({ "anthropic-ratelimit-unified-reset": String(resetEpochSecs) }),
        NOW,
      ),
    ).toBe(3_600_000)
  })

  it("undefined when the wall names no reset (insufficient balance — money, not time)", () => {
    expect(quotaResetDelayMs(quotaError({}), NOW)).toBeUndefined()
    expect(
      quotaResetDelayMs(
        new AiError.UnknownError({ module: "T", method: "chat", description: "CreditsError" }),
        NOW,
      ),
    ).toBeUndefined()
  })
})

// The Claude Code behavior: session cap met ⇒ sleep till it resets, visibly.
describe("planQuotaPark", () => {
  const base = {
    cls: "quota" as const,
    policy: "interactive" as const,
    depth: 0,
    resetDelayMs: 2 * 60 * 60_000, // resets in 2h
    parkedMs: 0,
  }

  it("parks an interactive ROOT on a quota wall with a knowable reset", () => {
    const plan = planQuotaPark(base)
    expect(plan.park).toBe(true)
    expect(plan.delayMs).toBeGreaterThanOrEqual(base.resetDelayMs) // + wake margin
  })

  it("never parks headless / unattended runs (nobody is watching; the deadline owns them)", () => {
    expect(planQuotaPark({ ...base, policy: "headless" }).park).toBe(false)
    expect(planQuotaPark({ ...base, policy: undefined }).park).toBe(false)
  })

  it("never parks a sub-agent (the root parks; a parked fleet burns for nothing)", () => {
    expect(planQuotaPark({ ...base, depth: 1 }).park).toBe(false)
  })

  it("never parks without a reset time, past the 24h ceiling, or on a non-quota class", () => {
    expect(planQuotaPark({ ...base, resetDelayMs: undefined }).park).toBe(false)
    expect(planQuotaPark({ ...base, parkedMs: QUOTA_PARK_CEILING_MS }).park).toBe(false)
    expect(planQuotaPark({ ...base, cls: "transient" }).park).toBe(false)
    expect(planQuotaPark({ ...base, cls: "auth" }).park).toBe(false)
  })
})
