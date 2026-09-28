import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { entryId, estimateMessageTokens, renderLog, ToolCallId, UserMessage } from "@xandreed/core"
import type { LogBody, LogEntry, ToolViews } from "@xandreed/core"
import { WINDOW_STRATEGY, windowPolicy } from "./plugin.adapter.js"

const config = {
  compactPreviousTurn: true, turnContext: "current" as const, replies: true, spillMinChars: 100, previewChars: 20, ledgerTurnChars: 40,
  digestOnWriteChars: 0, digests: true, media: "none" as const, maxImages: 8,
}
const views: ToolViews = {
  view: (_tool, encoded) => Effect.succeed({ text: String(encoded), version: "1", subjects: [], artifacts: [], pinned: false }),
  compact: (_tool, encoded) => Effect.succeed(Option.some(`(compact ${String(encoded).length})`)),
  digest: () => Effect.succeed(Option.none()),
}
const at = (seq: number, turn: number, body: LogBody): LogEntry => ({ id: entryId(`run-${turn}`, seq), runId: `run-${turn}`, turn, step: 0, at: seq, body })
const result = (seq: number, turn: number, view: string): LogEntry => at(seq, turn, {
  _tag: "ToolResult", toolCallId: ToolCallId.make(`c${seq}`), toolName: "lookup", isError: false, encoded: view, view, viewVersion: "1", subjects: [], artifacts: [], pinned: false,
})
const call = (seq: number, turn: number, id: number): LogEntry => at(seq, turn, { _tag: "Message", message: { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make(`c${id}`), toolName: "lookup", input: {} }] } })
const log = (big: string): ReadonlyArray<LogEntry> => [
  at(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "first question" }) }), call(1, 1, 2), result(2, 1, big),
  at(3, 1, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("first answer") }),
  at(4, 2, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "second question" }) }), call(5, 2, 6), result(6, 2, big),
]
const policy = windowPolicy(config)
const render = (entries: ReadonlyArray<LogEntry>) => renderLog(entries, { ...policy.render, stepContext: "tail", strategy: WINDOW_STRATEGY.id, currentTurn: 2, currentRun: "run-2" })
const maintain = (entries: ReadonlyArray<LogEntry>, budgetTokens: number, phase: "turn-start" | "step" = "turn-start") =>
  Effect.runPromise(Effect.either(policy.maintain({ entries, signal: { phase, lastUsage: Option.none(), budgetTokens, views }, turn: 2, runId: "run-2", render })))

describe("window memory policy", () => {
  test("at turn start, earlier tool results switch to their compact views", async () => {
    const decided = await maintain(log("x".repeat(500)), 100_000)
    expect(decided).toMatchObject({ _tag: "Right", right: { actions: [{ _tag: "CompactViews", entries: ["run-1:2"], texts: ["(compact 500)"] }], digest: [] } })
  })
  test("under pressure it spills the current turn's largest result, then drops old turns, then fails", async () => {
    const entries = log("x".repeat(3_000))
    const tokens = estimateMessageTokens(render(entries))
    const spilled = await maintain(entries, tokens - 500, "step")
    expect(spilled).toMatchObject({ _tag: "Right", right: { actions: [{ _tag: "Spill", entry: "run-2:6" }] } })
    const dropped = await maintain(entries, 400, "step")
    expect(dropped).toMatchObject({ _tag: "Right", right: { actions: [{ _tag: "Spill" }, { _tag: "DropTurns", throughTurn: 1 }] } })
    const impossible = await maintain(entries, 5, "step")
    expect(impossible).toMatchObject({ _tag: "Left", left: { code: "context.budget" } })
  })
})
