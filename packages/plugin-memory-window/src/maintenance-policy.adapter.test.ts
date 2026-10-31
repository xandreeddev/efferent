import { expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { entryId, estimateMessageTokens, ModelId, ModelSelection, pendingCompaction, ProviderId, renderLog, RunId, RunOrdinal, scaledTokens, ToolCallId, UserMessage } from "@xandreed/core"
import type { LogEntry, MaintainSignal, MemoryObservation } from "@xandreed/core"
import { memoryWindowDefaults, WINDOW_STRATEGY, windowPolicy } from "./plugin.adapter.js"

const id = RunId.make("test")
const entries: ReadonlyArray<LogEntry> = [
  { id: entryId(id, 0), runId: id, turn: 1, step: 0, at: 0, body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "question" }) } },
  { id: entryId(id, 1), runId: id, turn: 1, step: 0, at: 0, body: { _tag: "ToolResult", toolCallId: ToolCallId.make("call"), toolName: "lookup", encoded: "raw", view: "x".repeat(3000), viewVersion: "1", subjects: [], artifacts: [], pinned: false, isError: false } },
]
const signal: MaintainSignal = { phase: "step", lastUsage: Option.none(), budgetTokens: 1000, views: { view: () => Effect.die("unused"), compact: () => Effect.succeed(Option.none()), digest: () => Effect.succeed(Option.none()) } }
const policy = windowPolicy(memoryWindowDefaults)
const render = (all: ReadonlyArray<LogEntry>) => renderLog(all, { ...policy.render, strategy: WINDOW_STRATEGY.id, currentTurn: 1, currentRun: id, run: RunOrdinal.make(0), stepContext: "none" })
const observed: MemoryObservation = { model: new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("actual") }), inputTokens: 2200, estimatedTokens: 1000, reservedTokens: 200 }

test("window fitting and spill candidates use calibrated estimates", async () => {
  const budgetTokens = estimateMessageTokens(render(entries)) + 10
  expect((await Effect.runPromise(policy.maintain({ entries, signal: { ...signal, budgetTokens }, turn: 1, runId: id, render }))).actions).toEqual([])
  const decided = await Effect.runPromise(policy.maintain({ entries, signal: { ...signal, budgetTokens, observed }, turn: 1, runId: id, render }))
  expect(decided.actions).toMatchObject([{ _tag: "Spill", entry: "test:1" }])
})

test("turn-end irreducible pressure is advisory while the next step remains strict", async () => {
  const current = [entries[0]!]
  const request = { entries: current, turn: 1, runId: id, render }
  expect((await Effect.runPromise(policy.maintain({ ...request, signal: { ...signal, phase: "turn-end", budgetTokens: 1 } }))).actions).toEqual([])
  const strict = await Effect.runPromise(Effect.result(policy.maintain({ ...request, signal: { ...signal, budgetTokens: 1 } })))
  expect(strict._tag === "Failure" && strict.failure.code).toBe("context.budget")
})

test("advisory dropping never expands a small old turn into a larger ledger", async () => {
  const older: LogEntry = { ...entries[0]!, body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "x" }) } }
  const current: LogEntry = { ...entries[0]!, id: entryId(id, 2), turn: 2, body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "irreducible current request" }) } }
  const all = [older, current]
  const actualRender = (candidate: ReadonlyArray<LogEntry>) => renderLog(candidate, { ...policy.render, strategy: WINDOW_STRATEGY.id, currentTurn: 2, currentRun: id, run: RunOrdinal.make(0), stepContext: "none" })
  expect((await Effect.runPromise(policy.maintain({ entries: all, signal: { ...signal, phase: "turn-end", budgetTokens: 1 }, turn: 2, runId: id, render: actualRender }))).actions).toEqual([])
})

test("overflow returns a strict old-history reduction even when the protected current turn cannot fit", async () => {
  const older: LogEntry = { ...entries[0]!, body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "earlier evidence ".repeat(400) }) } }
  const current: LogEntry = { ...entries[0]!, id: entryId(id, 2), turn: 2, body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "protected current evidence ".repeat(100) }) } }
  const all = [older, current]
  const actualRender = (candidate: ReadonlyArray<LogEntry>) => renderLog(candidate, { ...policy.render, strategy: WINDOW_STRATEGY.id, currentTurn: 2, currentRun: id, run: RunOrdinal.make(0), stepContext: "none" })
  const decided = await Effect.runPromise(policy.maintain({ entries: all, signal: { ...signal, phase: "overflow", budgetTokens: 1, observed }, turn: 2, runId: id, render: actualRender }))
  expect(decided.actions).toMatchObject([{ _tag: "DropTurns", throughTurn: 1 }])
  const after = [...all, ...decided.actions.map(action => pendingCompaction(WINDOW_STRATEGY, action, 0))]
  expect(scaledTokens(estimateMessageTokens(actualRender(after)), Option.some(observed))).toBeLessThan(scaledTokens(estimateMessageTokens(actualRender(all)), Option.some(observed)))
  expect(estimateMessageTokens(actualRender(after))).toBeGreaterThan(1)
  expect(JSON.stringify(actualRender(after))).toContain("protected current evidence")
  expect(all).toEqual([older, current])
})
