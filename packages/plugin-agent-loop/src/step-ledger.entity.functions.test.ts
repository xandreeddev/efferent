import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { EntryId, RunId, tokenUsage, ToolCallId } from "@xandreed/core"
import type { LogEntry, StepPlan } from "@xandreed/core"
import { emptyLedger } from "./step-ledger.entity.js"
import { cachedPlan, planned, replanned, started, stepResultsOf, used } from "./step-ledger.entity.functions.js"

const plan = (system: string): StepPlan => ({ model: Option.none(), system, messages: [], toolChoice: Option.none() })
const entry = (n: number, body: LogEntry["body"]): LogEntry => ({ id: EntryId.make(`run-1:${n}`), runId: RunId.make("run-1"), turn: 1, step: 0, at: 0, body })
const result = (n: number, isError: boolean) => entry(n, {
  _tag: "ToolResult", toolCallId: ToolCallId.make(`c${n}`), toolName: "probe", isError,
  encoded: n, view: String(n), viewVersion: "1", subjects: [], artifacts: [], pinned: false,
})

describe("the step ledger", () => {
  test("serves a step's plan to that step only, until it is dropped", () => {
    const ledger = planned(2, plan("two"))(emptyLedger)
    expect(Option.map(cachedPlan(ledger, 2), (cached) => cached.system)).toEqual(Option.some("two"))
    expect(cachedPlan(ledger, 3)).toEqual(Option.none())
    expect(cachedPlan(replanned(ledger), 2)).toEqual(Option.none())
  })

  test("counts the steps that started, whatever their order", () => {
    expect([started(0), started(2), started(1)].reduce((ledger, update) => update(ledger), emptyLedger).steps).toBe(3)
  })

  test("keeps the last usage", () => {
    const usage = tokenUsage({ inputTokens: 4, outputTokens: 2 })
    expect(used(usage)(emptyLedger).lastUsage).toEqual(Option.some(usage))
  })

  test("projects recorded tool results in journal order and leaves non-result entries out", () => {
    const entries = [entry(0, { _tag: "Message", message: { role: "user", content: "go" } }), result(2, true), result(1, false)]
    expect(stepResultsOf(entries).map((stepResult) => [String(stepResult.entry), String(stepResult.toolCallId), stepResult.ok])).toEqual([["run-1:2", "c2", false], ["run-1:1", "c1", true]])
    expect(stepResultsOf([])).toEqual([])
  })
})
