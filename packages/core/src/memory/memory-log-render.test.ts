import { expect, test } from "bun:test"
import { ToolCallId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { buildContext, entryId, renderLog } from "./memory-log.entity.functions.js"
import type { LogEntry } from "./memory-log.entity.js"

/**
 * A long session as a durable log: each turn's message, then per step an
 * assistant call, its raw result and the result's presentation, then a
 * compaction of the turn's first view, as a long-running agent records them.
 */
const sessionOf = (turns: number, steps: number): ReadonlyArray<LogEntry> => {
  const runId = RunId.make("long-run")
  return Array.from({ length: turns }, (_, index) => index + 1).flatMap((turn) => {
    const at = (offset: number, step: number, body: LogEntry["body"]): LogEntry => ({ id: entryId(runId, turn * 1000 + offset), runId, turn, step, at: 0, body })
    return [
      at(0, 0, { _tag: "TurnStarted", userMessage: new UserMessage({ text: `task ${turn}` }) }),
      ...Array.from({ length: steps }, (_, step) => step).flatMap((step) => {
        const id = ToolCallId.make(`call_${turn}_${step}`)
        const result = at(3 * step + 2, step, { _tag: "ToolResult", toolCallId: id, run: RunOrdinal.make(0), toolName: "read", isError: false, encoded: `file ${turn}.${step}`, view: `file ${turn}.${step}`, viewVersion: "raw", subjects: [], artifacts: [], pinned: false })
        return [
          at(3 * step + 1, step, { _tag: "Message", run: RunOrdinal.make(0), message: { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read", input: { step } }] } }),
          result,
          at(3 * step + 3, step, { _tag: "ToolPresentation", entry: result.id, view: `read ${turn}.${step}`, viewVersion: "1", subjects: [], artifacts: [], pinned: false, media: [], mediaNotes: [] }),
        ]
      }),
      at(999, 0, { _tag: "Compaction", strategy: "window", version: "1", action: { _tag: "CompactViews", entries: [entryId(runId, turn * 1000 + 2)], texts: [`compact ${turn}`] } }),
    ]
  })
}

test("a long session's render grows with its length, not its square: 25,600 entries build in well under the time a quadratic render takes", () => {
  const entries = sessionOf(800, 10)
  const options = {
    strategy: "window", currentTurn: 800, currentRun: RunId.make("long-run"), run: RunOrdinal.make(0), turnContext: "current" as const,
    replies: true, stepContext: "tail" as const, digests: true, media: { mode: "none" as const, maxImages: 0, maxChars: 0 },
  }
  const started = performance.now()
  const built = buildContext(entries, options)
  const elapsed = performance.now() - started
  // 800 turns of 10 steps: a message, then 10 calls and their merged-per-step results each.
  expect(built.messages).toHaveLength(800 * 21)
  // Linear, this takes about a tenth of a second; the quadratic passes it replaced took about ten.
  expect(elapsed).toBeLessThan(2_500)
})

test("a request's results render in the order of its calls, whatever order they returned and were recorded in", () => {
  const runId = RunId.make("run-1")
  const at = (index: number, body: LogEntry["body"]): LogEntry => ({ id: entryId(runId, index), runId, turn: 1, step: 0, at: index, body })
  const result = (index: number, call: string): LogEntry => at(index, {
    _tag: "ToolResult", toolCallId: ToolCallId.make(call), run: RunOrdinal.make(0), toolName: "read", isError: false,
    encoded: call, view: `result of ${call}`, viewVersion: "raw", subjects: [], artifacts: [], pinned: false,
  })
  const entries = [
    at(0, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "read both" }) }),
    at(1, { _tag: "Message", run: RunOrdinal.make(0), message: { role: "assistant", content: [
      { type: "tool-call", toolCallId: ToolCallId.make("first"), toolName: "read", input: {} },
      { type: "tool-call", toolCallId: ToolCallId.make("second"), toolName: "read", input: {} },
    ] } }),
    // The second call returned first.
    result(2, "second"),
    result(3, "first"),
  ]
  const options = {
    strategy: "window", currentTurn: 1, currentRun: runId, run: RunOrdinal.make(0), turnContext: "current" as const,
    replies: true, stepContext: "tail" as const, digests: false, media: { mode: "none" as const, maxImages: 0, maxChars: 0 },
  }
  const shown = renderLog(entries, options).flatMap((message) => message.role === "tool" ? message.content.map((part) => String(part.toolCallId)) : [])
  expect(shown).toEqual(["first", "second"])
  expect(renderLog(entries, options)).toEqual(renderLog([entries[0]!, entries[1]!, entries[3]!, entries[2]!], options))
})
