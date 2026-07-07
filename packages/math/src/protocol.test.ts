import { Option } from "effect"
import { describe, expect, test } from "bun:test"
import {
  composeAgentMessage,
  formatAction,
  formatProgress,
  parseAgentBoundMessage,
  type ProgressEntry,
} from "./protocol.js"

describe("math protocol", () => {
  test("format: the documented shapes, verbatim", () => {
    expect(formatAction({ kind: "start", grade: 4, theme: "fractions" })).toBe(
      `[action] start grade=4 theme="fractions"`,
    )
    expect(formatAction({ kind: "topic", grade: 6, theme: "decimals" })).toBe(
      `[action] topic grade=6 theme="decimals"`,
    )
    expect(formatAction({ kind: "more" })).toBe("[action] more")
    expect(
      formatProgress([
        { ex: "ex-3", result: "correct", attempts: 1 },
        { ex: "ex-4", result: "wrong", attempts: 2, gaveUp: true },
        { ex: "ex-5", result: "reported", attempts: 1, student: "6/8", key: "3/4" },
      ]),
    ).toBe(
      `[progress] ex-3 correct attempts=1 · ex-4 wrong attempts=2 gave-up · ex-5 reported attempts=1 student="6/8" key="3/4"`,
    )
  })

  test("roundtrip: every composed message parses back to its parts", () => {
    const entries: ReadonlyArray<ProgressEntry> = [
      { ex: "ex-1", result: "correct", attempts: 2 },
      { ex: "ex-2", result: "revealed", attempts: 1 },
      { ex: "ex-3", result: "reported", attempts: 3, student: `a "quoted" answer`, key: "x=2" },
      { ex: "ex-4", result: "wrong", attempts: 2, gaveUp: true },
    ]
    ;[
      { kind: "start", grade: 4, theme: "fractions" } as const,
      { kind: "topic", grade: 6, theme: `long division` } as const,
      { kind: "more" } as const,
      { kind: "harder" } as const,
      { kind: "easier" } as const,
    ].forEach((action) => {
      const msg = composeAgentMessage(entries, action)
      const parsed = Option.getOrThrow(parseAgentBoundMessage(msg))
      expect(parsed.action).toEqual(action)
      expect(parsed.progress).toEqual(entries)
    })
  })

  test("progress-less messages and theme-less actions roundtrip too", () => {
    const msg = composeAgentMessage([], { kind: "start", grade: 2 })
    expect(msg).toBe("[action] start grade=2")
    expect(Option.getOrThrow(parseAgentBoundMessage(msg))).toEqual({ action: { kind: "start", grade: 2 }, progress: [] })
  })

  test("a human/foreign message never parses (replay skips it)", () => {
    expect(Option.isNone(parseAgentBoundMessage("please give me fractions"))).toBe(true)
    expect(Option.isNone(parseAgentBoundMessage("[ui:practice] answer=\"3\""))).toBe(true)
    expect(Option.isNone(parseAgentBoundMessage(""))).toBe(true)
  })
})
