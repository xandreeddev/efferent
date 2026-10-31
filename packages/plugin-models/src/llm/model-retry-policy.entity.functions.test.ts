import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { modelRetryDefaults } from "./model-retry-policy.entity.js"
import type { ModelRequestState } from "./model-retry-policy.entity.js"
import { enterFallbackState, primaryAttemptLimit, retryAfterMillis, retryDelayMillis, startAttemptState } from "./model-retry-policy.entity.functions.js"

describe("request policy decisions", () => {
  test("Retry-After supports integer seconds and HTTP dates, never decimal/negative/nonfinite guesses", () => {
    const now = Date.parse("Sat, 31 Oct 2026 00:00:00 GMT")
    expect(retryAfterMillis("15", now)).toEqual(Option.some(15000))
    expect(retryAfterMillis("0", now)).toEqual(Option.some(0))
    expect(retryAfterMillis("Sat, 31 Oct 2026 00:00:02 GMT", now)).toEqual(Option.some(2000))
    expect(retryAfterMillis("Fri, 30 Oct 2026 00:00:00 GMT", now)).toEqual(Option.some(0))
    ;["-1", "0.5", "Infinity", "NaN", "", "tomorrow", "999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999"].forEach((value) => expect(retryAfterMillis(value, now)).toEqual(Option.none()))
  })

  test("one ordinal drives bounded exponential jitter and the capped server hint", () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelayMillis(modelRetryDefaults, attempt, 0.5, Option.none(), 0))).toEqual([1000, 2000, 4000, 4000])
    expect(retryDelayMillis(modelRetryDefaults, 1, 0, Option.none(), 0)).toBe(800)
    expect(retryDelayMillis(modelRetryDefaults, 1, 1, Option.none(), 0)).toBe(1200)
    expect(retryDelayMillis(modelRetryDefaults, 3, 1, Option.none(), 0)).toBe(4000)
    expect(retryDelayMillis(modelRetryDefaults, 1, 0.5, Option.some("120"), 0)).toBe(60000)
    expect(retryDelayMillis(modelRetryDefaults, 1, 0.5, Option.some("bad"), 0)).toBe(1000)
    expect(retryDelayMillis({ ...modelRetryDefaults, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }, 2000, 0.5, Option.none(), 0)).toBe(0)
  })

  test("a distinct fallback reserves only the final total attempt, never a separate counter", () => {
    expect(primaryAttemptLimit(modelRetryDefaults, true)).toBe(3)
    expect(primaryAttemptLimit(modelRetryDefaults, false)).toBe(4)
    expect(primaryAttemptLimit({ ...modelRetryDefaults, maxAttempts: 1 }, true)).toBe(1)
    expect(startAttemptState({ _tag: "Ready", rung: "Primary", attempts: 0 }, modelRetryDefaults, true)).toEqual(Option.some({ _tag: "Sending", rung: "Primary", attempts: 1 }))
    const rejected: ModelRequestState = { _tag: "Rejected", rung: "Primary", attempts: 3, kind: "Transient", replayable: true }
    expect(startAttemptState(rejected, modelRetryDefaults, true)).toEqual(Option.none())
    const fallback = enterFallbackState(rejected, modelRetryDefaults, true)
    expect(fallback).toEqual(Option.some({ _tag: "Ready", rung: "Fallback", attempts: 3 }))
    if (Option.isNone(fallback)) return
    expect(startAttemptState(fallback.value, modelRetryDefaults, true)).toEqual(Option.some({ _tag: "Sending", rung: "Fallback", attempts: 4 }))
    expect(enterFallbackState({ ...rejected, rung: "Fallback", attempts: 4 }, modelRetryDefaults, true)).toEqual(Option.none())
  })

  test("committed, permanent, one-shot and unexhausted requests cannot enter a fallback", () => {
    const states: ReadonlyArray<ModelRequestState> = [
      { _tag: "Committed", rung: "Primary", attempts: 1 },
      { _tag: "Sending", rung: "Primary", attempts: 1 },
      { _tag: "Rejected", rung: "Primary", attempts: 3, kind: "InvalidRequest", replayable: true },
      { _tag: "Rejected", rung: "Primary", attempts: 3, kind: "Transient", replayable: false },
      { _tag: "Rejected", rung: "Primary", attempts: 2, kind: "Transient", replayable: true },
    ]
    states.forEach((state) => expect(enterFallbackState(state, modelRetryDefaults, true)).toEqual(Option.none()))
    expect(startAttemptState(states[0]!, modelRetryDefaults, false)).toEqual(Option.none())
    expect(startAttemptState(states[1]!, modelRetryDefaults, false)).toEqual(Option.none())
  })
})
