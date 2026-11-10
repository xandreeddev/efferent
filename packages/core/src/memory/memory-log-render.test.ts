import { expect, test } from "bun:test"
import { Option } from "effect"
import { ToolCallId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { buildContext, entryId, renderLog, shownResults } from "./memory-log.entity.functions.js"
import { ArtifactId } from "./memory-log.entity.js"
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

test("the results a render shows are the ones shownResults lists, each with what wrote its text", () => {
  const first = RunId.make("run-1"), second = RunId.make("run-2")
  const at = (runId: RunId, turn: number, index: number, body: LogEntry["body"]): LogEntry => ({ id: entryId(runId, index), runId, turn, step: 0, at: index, body })
  const result = (index: number, call: string, view: string, pinned = false): LogEntry => at(first, 1, index, {
    _tag: "ToolResult", toolCallId: ToolCallId.make(call), run: RunOrdinal.make(0), toolName: "read", isError: false,
    encoded: call, view, viewVersion: "raw", subjects: [], artifacts: [{ id: ArtifactId.make(`${call}.pdf`), kind: "file", mediaType: "application/pdf", url: `https://files.example/${call}`, alt: Option.none() }], pinned,
  })
  const compaction = (runId: RunId, turn: number, index: number, strategy: string, action: Extract<LogEntry["body"], { readonly _tag: "Compaction" }>["action"]): LogEntry =>
    at(runId, turn, index, { _tag: "Compaction", strategy, version: "1", action })
  const entries = [
    at(first, 1, 0, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "read them" }) }),
    at(first, 1, 1, { _tag: "Message", run: RunOrdinal.make(0), message: { role: "assistant", content: ["whole", "compact", "spilled", "digested", "both", "pinned", "lost"]
      .map((call) => ({ type: "tool-call" as const, toolCallId: ToolCallId.make(call), toolName: "read", input: {} })) } }),
    result(2, "whole", "the whole view"),
    result(3, "compact", "a long view"),
    result(4, "spilled", "a view too long"),
    result(5, "digested", "a view to digest"),
    result(6, "both", "a view spilled and digested"),
    result(7, "pinned", "a pinned view", true),
    compaction(first, 1, 8, "window", { _tag: "CompactViews", entries: [entryId(first, 3)], texts: ["compact"] }),
    compaction(first, 1, 9, "window", { _tag: "Spill", entry: entryId(first, 4), preview: "a view…" }),
    // Another strategy's spill of the first result applies to no render of this one.
    compaction(first, 1, 10, "summary", { _tag: "Spill", entry: entryId(first, 2), preview: "another strategy's" }),
    at(first, 1, 11, { _tag: "ToolDigest", entry: entryId(first, 5), version: "1", mode: "summarize", keep: [], text: "digest", digester: "test@1", trigger: "write" }),
    // A spill beats a digest of the same result.
    at(first, 1, 12, { _tag: "ToolDigest", entry: entryId(first, 6), version: "1", mode: "summarize", keep: [], text: "its digest", digester: "test@1", trigger: "write" }),
    compaction(first, 1, 13, "window", { _tag: "Spill", entry: entryId(first, 6), preview: "a view spilled…" }),
    at(first, 1, 14, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("read") }),
    at(second, 2, 0, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "and now?" }) }),
  ]
  const options = (currentTurn: number, digests: boolean) => ({
    strategy: "window", currentTurn, currentRun: currentTurn === 1 ? first : second, run: RunOrdinal.make(0), turnContext: "current" as const,
    replies: true, stepContext: "tail" as const, digests, media: { mode: "none" as const, maxImages: 4, maxChars: 0 },
  })
  const parts = (log: ReadonlyArray<LogEntry>, digests: boolean) => renderLog(log, options(2, digests)).flatMap((message) => message.role === "tool" ? message.content : [])
  // The call with no recorded result is answered by the render itself: that answer is no result of the log.
  const rendered = (log: ReadonlyArray<LogEntry>, digests: boolean) => parts(log, digests).filter((part) => part.toolCallId !== "lost")
  expect(parts(entries, true).filter((part) => part.toolCallId === "lost").map((part) => part.isError)).toEqual([true])
  const listed = shownResults(entries, options(2, true))
  // The same parts, in the same order, as the messages hold: the text, its artifact lines, the call it answers.
  expect(listed.map((shown) => shown.part)).toEqual(rendered(entries, true))
  expect(listed.map((shown) => [String(shown.part.toolCallId), shown.by, Option.getOrElse(Option.map(shown.source, String), () => "its own view"), String(shown.part.output).split("\n")[0]])).toEqual([
    ["whole", "View", "its own view", "the whole view"],
    ["compact", "CompactViews", "run-1:8", "compact"],
    ["spilled", "Spill", "run-1:9", "a view…"],
    ["digested", "ToolDigest", "run-1:11", "digest"],
    ["both", "Spill", "run-1:13", "a view spilled…"],
    ["pinned", "View", "its own view", "a pinned view"],
  ])
  // A render that shows no digests shows the digested result's own view.
  const plain = shownResults(entries, options(2, false))
  expect(plain.map((shown) => shown.part)).toEqual(rendered(entries, false))
  expect(plain.map((shown) => shown.by)).toEqual(["View", "CompactViews", "Spill", "View", "Spill", "View"])
  // Once the first turn is dropped, only its pinned result is still shown, and listed.
  const dropped = [...entries, compaction(second, 2, 1, "window", { _tag: "DropTurns", throughTurn: 1, ledger: "Earlier in this conversation:" })]
  expect(shownResults(dropped, options(2, true)).map((shown) => shown.part)).toEqual(rendered(dropped, true))
  expect(shownResults(dropped, options(2, true)).map((shown) => String(shown.part.toolCallId))).toEqual(["pinned"])
})
