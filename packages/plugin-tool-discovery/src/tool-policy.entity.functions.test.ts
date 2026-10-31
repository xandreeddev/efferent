import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { admitTool, breakerOf, concurrencyMessage, emptyToolAdmission, runCallLimitMessage, settledBreaker, settleToolAdmission, trippedMessage } from "./tool-policy.entity.functions.js"
import { ToolAdmission, ToolBreaker, ToolPolicy } from "./tool-policy.entity.js"

describe("per-tool host policy", () => {
  test("bounded policy validates caps, thresholds and concurrency", () => {
    const decode = Schema.decodeUnknownOption(ToolPolicy)
    expect(Option.isSome(decode({}))).toBe(true)
    expect(Option.isSome(decode({ concurrency: 1, maxCallsPerRun: 0, breakAfter: 2, breakOn: "failures" }))).toBe(true)
    expect([ { concurrency: 0 }, { concurrency: Infinity }, { maxCallsPerRun: -1 }, { breakAfter: 0 }, { breakOn: "anything" } ].map((input) => Option.isNone(decode(input)))).toEqual([true, true, true, true, true])
  })
  test("relevant defects accumulate, success resets and unrelated exits leave a tripped breaker unchanged", () => {
    const initial = { _tag: "Closed", failures: 0 } as const
    const first = settledBreaker(initial, { breakAfter: 2 }, "defect")
    expect(first).toEqual({ _tag: "Closed", failures: 1 })
    expect(settledBreaker(first, { breakAfter: 2 }, "failure")).toEqual(first)
    expect(settledBreaker(first, { breakAfter: 2 }, "success")).toEqual(initial)
    expect(settledBreaker(first, { breakAfter: 2 }, "unrelated")).toEqual(first)
    const tripped = settledBreaker(first, { breakAfter: 2 }, "defect")
    expect(tripped).toEqual({ _tag: "Tripped", failures: 2 })
    expect(settledBreaker(tripped, { breakAfter: 2 }, "success")).toEqual(tripped)
    expect(settledBreaker(initial, { breakAfter: 1, breakOn: "failures" }, "failure")).toEqual({ _tag: "Tripped", failures: 1 })
  })
  test("the run cap does not consume a rejected slot or widen author or whole-turn limits", () => {
    const first = admitTool(emptyToolAdmission, "run0", "read", { maxCallsPerRun: 1 }, 2, Option.some(2))
    expect(first[0]).toEqual(Option.none())
    expect(admitTool(first[1], "run0", "read", { maxCallsPerRun: 1 }, 2, Option.some(2))).toEqual([Option.some("run-call-limit"), first[1]])
    const second = admitTool(first[1], "run1", "read", { maxCallsPerRun: 100 }, 2, Option.some(2))
    expect(second[0]).toEqual(Option.none())
    expect(admitTool(second[1], "run2", "read", {}, 3, Option.some(2))[0]).toEqual(Option.some("tool-call-limit"))
    expect(admitTool(second[1], "run2", "other", {}, 2, Option.none())[0]).toEqual(Option.some("call-limit"))
  })
  test("refusal wording is exact", () => {
    expect(trippedMessage()).toBe("This tool has reached its failure limit for this run; use another tool or report what blocked the task")
    expect(concurrencyMessage()).toBe("This tool cannot run inside the current tool call while its execution limits are occupied; finish the current call before trying again")
    expect(runCallLimitMessage(1)).toBe("This tool may be called at most once per run; use what its earlier calls returned")
    expect(runCallLimitMessage(0)).toBe("This tool is disabled for this run; use another tool or report what blocked the task")
    expect(runCallLimitMessage(3)).toBe("This tool may be called at most 3 times per run; use what its earlier calls returned")
  })
  test.each(["constructor", "toString", "__proto__"])("object prototype names are ordinary tool and run keys: %s", (name) => {
    const first = admitTool(emptyToolAdmission, name, name, { maxCallsPerRun: 1 }, 8, Option.none())
    expect(first[1].turn[name]).toBe(1)
    expect(admitTool(first[1], name, name, { maxCallsPerRun: 1 }, 8, Option.none())[0]).toEqual(Option.some("run-call-limit"))
    const settled = settleToolAdmission(first[1], name, name, { breakAfter: 1 }, "defect")
    expect(breakerOf(settled, name, name)).toEqual({ _tag: "Tripped", failures: 1 })
  })
  test("admission counters are nonnegative and a tripped breaker has at least one failure", () => {
    expect(Option.isNone(Schema.decodeUnknownOption(ToolBreaker)({ _tag: "Closed", failures: -1 }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(ToolBreaker)({ _tag: "Tripped", failures: 0 }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(ToolAdmission)({ turn: { tool: -1 }, runs: {} }))).toBe(true)
    expect(Option.isNone(Schema.decodeUnknownOption(ToolAdmission)({ turn: {}, runs: { run: { calls: { tool: -1 }, breakers: {} } } }))).toBe(true)
  })
})
