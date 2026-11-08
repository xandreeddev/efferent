import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { modelRetryDefaults } from "./model-retry-policy.entity.js"
import type { ModelRequestState } from "./model-retry-policy.entity.js"
import { enterFallbackState, primaryAttemptLimit, retryAfterMillis, retryAfterMsMillis, retryDelayMillis, retryHintMillis, startAttemptState } from "./model-retry-policy.entity.functions.js"

describe("request policy decisions", () => {
  test("Retry-After supports seconds (decimals as the provider SDKs read them) and HTTP dates, never negative/nonfinite guesses", () => {
    const now = Date.parse("Sat, 31 Oct 2026 00:00:00 GMT")
    expect(retryAfterMillis("15", now)).toEqual(Option.some(15000))
    expect(retryAfterMillis("0", now)).toEqual(Option.some(0))
    expect(retryAfterMillis("0.5", now)).toEqual(Option.some(500))
    expect(retryAfterMillis(" 1.25 ", now)).toEqual(Option.some(1250))
    expect(retryAfterMillis(".5", now)).toEqual(Option.some(500))
    expect(retryAfterMillis("Sat, 31 Oct 2026 00:00:02 GMT", now)).toEqual(Option.some(2000))
    expect(retryAfterMillis("Fri, 30 Oct 2026 00:00:00 GMT", now)).toEqual(Option.some(0))
    ;["-1", "-0.5", "1e3", "0x10", ".", "Infinity", "NaN", "", "tomorrow", "999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999"].forEach((value) => expect(retryAfterMillis(value, now)).toEqual(Option.none()))
  })

  test("retry-after-ms, then retry-after: the server hint a rejected response carries", () => {
    const now = Date.parse("Sat, 31 Oct 2026 00:00:00 GMT")
    expect(retryAfterMsMillis("1500")).toEqual(Option.some(1500))
    expect(retryAfterMsMillis("12.5")).toEqual(Option.some(12.5))
    ;["-1", "soon", "", "Infinity"].forEach((value) => expect(retryAfterMsMillis(value)).toEqual(Option.none()))
    expect(retryHintMillis({ "retry-after-ms": "250", "retry-after": "9" }, now)).toEqual(Option.some(250))
    expect(retryHintMillis({ "retry-after-ms": "bad", "retry-after": "2" }, now)).toEqual(Option.some(2000))
    expect(retryHintMillis({ "retry-after": "1.5" }, now)).toEqual(Option.some(1500))
    expect(retryHintMillis({ "request-id": "fixture" }, now)).toEqual(Option.none())
  })

  test("one ordinal drives bounded exponential jitter and the capped server hint", () => {
    expect([1, 2, 3, 4].map((attempt) => retryDelayMillis(modelRetryDefaults, attempt, 0.5, Option.none()))).toEqual([1000, 2000, 4000, 4000])
    expect(retryDelayMillis(modelRetryDefaults, 1, 0, Option.none())).toBe(800)
    expect(retryDelayMillis(modelRetryDefaults, 1, 1, Option.none())).toBe(1200)
    expect(retryDelayMillis(modelRetryDefaults, 3, 1, Option.none())).toBe(4000)
    expect(retryDelayMillis(modelRetryDefaults, 1, 0.5, Option.some(120_000))).toBe(60000)
    expect(retryDelayMillis(modelRetryDefaults, 1, 0.5, Option.some(1500))).toBe(1500)
    expect(retryDelayMillis({ ...modelRetryDefaults, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }, 2000, 0.5, Option.none())).toBe(0)
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
    // The primary's backoff and server hint are its provider's: the fallback inherits no wait.
    expect(enterFallbackState({ ...rejected, retryAt: 9_999_999 }, modelRetryDefaults, true)).toEqual(Option.some({ _tag: "Ready", rung: "Fallback", attempts: 3 }))
    if (Option.isNone(fallback)) return
    expect(startAttemptState(fallback.value, modelRetryDefaults, true)).toEqual(Option.some({ _tag: "Sending", rung: "Fallback", attempts: 4 }))
    expect(enterFallbackState({ ...rejected, rung: "Fallback", attempts: 4 }, modelRetryDefaults, true)).toEqual(Option.none())
  })

  test("an explicitly final timeout cannot retry or enter a distinct fallback before its deadline", () => {
    const state: ModelRequestState = { _tag: "Final", rung: "Primary", attempts: 1, kind: "Timeout" }
    expect(startAttemptState(state, modelRetryDefaults, false)).toEqual(Option.none())
    expect(startAttemptState(state, modelRetryDefaults, true)).toEqual(Option.none())
    expect(enterFallbackState(state, modelRetryDefaults, true)).toEqual(Option.none())
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
