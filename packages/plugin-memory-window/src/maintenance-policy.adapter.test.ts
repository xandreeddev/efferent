import { describe, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import { entryId, estimateMessageTokens, ledgerOf, ModelId, ModelSelection, pendingCompaction, ProviderId, renderLog, RunId, RunOrdinal, scaledTokens, spillPreview, ToolCallId, UserMessage } from "@xandreed/core"
import type { CompactionAction, LogBody, LogEntry, MaintainSignal, MemoryObservation, MemoryPolicy } from "@xandreed/core"
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

describe("currentTurnFirst", () => {
  const options = { ...memoryWindowDefaults, spillMinChars: 100, previewChars: 20, ledgerTurnChars: 40, media: "none" as const }
  const spillFirst = windowPolicy(options)
  const currentFirst = windowPolicy({ ...options, currentTurnFirst: true })
  const at = (seq: number, turn: number, body: LogBody): LogEntry => ({ id: entryId(RunId.make(`run-${turn}`), seq), runId: RunId.make(`run-${turn}`), turn, step: 0, at: seq, body })
  const call = (seq: number, turn: number): LogEntry => at(seq, turn, { _tag: "Message", message: { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make(`c${seq + 1}`), toolName: "lookup", input: {} }] } })
  const result = (seq: number, turn: number, view: string): LogEntry => at(seq, turn, {
    _tag: "ToolResult", toolCallId: ToolCallId.make(`c${seq}`), toolName: "lookup", isError: false, encoded: view, view, viewVersion: "1", subjects: [], artifacts: [], pinned: false,
  })
  /** Turn 1 read `earlier` and answered; turn 2, the current one, read `current`. */
  const log = (earlier: string, current: string): ReadonlyArray<LogEntry> => [
    at(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "first question" }) }), call(1, 1), result(2, 1, earlier),
    at(3, 1, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("first answer") }),
    at(4, 2, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "second question" }) }), call(5, 2), result(6, 2, current),
  ]
  const renderTurn2 = (all: ReadonlyArray<LogEntry>) => renderLog(all, { ...currentFirst.render, strategy: WINDOW_STRATEGY.id, currentTurn: 2, currentRun: RunId.make("run-2"), run: RunOrdinal.make(0), stepContext: "none" })
  const tokensWith = (all: ReadonlyArray<LogEntry>, actions: ReadonlyArray<CompactionAction>) =>
    estimateMessageTokens(renderTurn2([...all, ...actions.map((action, index) => pendingCompaction(currentFirst.strategy, action, index))]))
  const maintain = (policy: MemoryPolicy, all: ReadonlyArray<LogEntry>, budgetTokens: number, phase: MaintainSignal["phase"] = "step") =>
    Effect.runPromise(Effect.result(policy.maintain({ entries: all, signal: { ...signal, phase, budgetTokens }, turn: 2, runId: RunId.make("run-2"), render: renderTurn2 })))
  const dropTurn1 = (all: ReadonlyArray<LogEntry>): CompactionAction => ({ _tag: "DropTurns", throughTurn: 1, ledger: ledgerOf(all, 1, options.ledgerTurnChars) })

  test("the strategy keeps its id and records the order in its version; the default is unchanged", () => {
    expect(memoryWindowDefaults.currentTurnFirst).toBe(false)
    expect(spillFirst.strategy).toEqual(WINDOW_STRATEGY)
    expect(currentFirst.strategy).toEqual({ id: WINDOW_STRATEGY.id, version: `${WINDOW_STRATEGY.version}+current-turn-first` })
  })

  test("earlier turns are condensed first: the oldest turn is dropped while the current turn's result stays whole", async () => {
    const all = log("x".repeat(3_000), "y".repeat(3_000))
    const budget = estimateMessageTokens(renderTurn2(all)) - 500
    expect(await maintain(spillFirst, all, budget)).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "Spill", entry: "run-2:6" }] } })
    expect(await maintain(currentFirst, all, budget)).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "DropTurns", throughTurn: 1 }] } })
  })

  test("the current turn's results are spilled only when the current turn alone does not fit", async () => {
    const all = log("x".repeat(3_000), "y".repeat(3_000))
    const alone = tokensWith(all, [dropTurn1(all)])
    expect(await maintain(currentFirst, all, alone)).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "DropTurns", throughTurn: 1 }] } })
    expect(await maintain(currentFirst, all, alone - 1)).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "Spill", entry: "run-2:6" }, { _tag: "DropTurns", throughTurn: 1 }] } })
  })

  test("once a result of the current turn is spilled, the earlier turns the budget still holds are kept", async () => {
    const all = log("x".repeat(200), "y".repeat(6_000))
    const decided = await maintain(currentFirst, all, tokensWith(all, [dropTurn1(all)]) - 1)
    expect(decided).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "Spill", entry: "run-2:6" }] } })
    expect(decided._tag === "Success" && decided.success.actions).toHaveLength(1)
  })

  test("context.budget only when nothing fits, and the end of a turn takes the smallest reduction instead", async () => {
    const all = log("x".repeat(3_000), "y".repeat(3_000))
    expect(await maintain(currentFirst, all, 5)).toMatchObject({ _tag: "Failure", failure: { code: "context.budget" } })
    expect(await maintain(currentFirst, all, 5, "turn-end")).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "Spill", entry: "run-2:6" }, { _tag: "DropTurns", throughTurn: 1 }] } })
  })

  test("compactions recorded under the default order keep applying, and are not decided again", async () => {
    const all = log("x".repeat(3_000), "y".repeat(3_000))
    const recorded: LogEntry = at(7, 2, { _tag: "Compaction", strategy: WINDOW_STRATEGY.id, version: WINDOW_STRATEGY.version, action: { _tag: "Spill", entry: entryId(RunId.make("run-2"), 6), preview: "y-preview" } })
    const replayed = [...all, recorded]
    expect(JSON.stringify(renderTurn2(replayed))).toContain("y-preview")
    expect(JSON.stringify(renderTurn2(replayed))).not.toContain("y".repeat(3_000))
    expect(await maintain(currentFirst, replayed, estimateMessageTokens(renderTurn2(replayed)))).toMatchObject({ _tag: "Success", success: { actions: [] } })
    expect(await maintain(currentFirst, replayed, estimateMessageTokens(renderTurn2(replayed)) - 1)).toMatchObject({ _tag: "Success", success: { actions: [{ _tag: "DropTurns", throughTurn: 1 }] } })
  })
})

describe("results bounded as they were written", () => {
  const options = { ...memoryWindowDefaults, spillMinChars: 100, previewChars: 20, ledgerTurnChars: 40, media: "none" as const }
  const window = windowPolicy(options)
  const run = (turn: number) => RunId.make(`run-${turn}`)
  const at = (seq: number, turn: number, body: LogBody): LogEntry => ({ id: entryId(run(turn), seq), runId: run(turn), turn, step: 0, at: seq, body })
  const call = (seq: number, turn: number): LogEntry => at(seq, turn, { _tag: "Message", message: { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make(`c${seq + 1}`), toolName: "lookup", input: {} }] } })
  const result = (seq: number, turn: number, view: string): LogEntry => at(seq, turn, {
    _tag: "ToolResult", toolCallId: ToolCallId.make(`c${seq}`), toolName: "lookup", isError: false, encoded: view, view, viewVersion: "1", subjects: [], artifacts: [], pinned: false,
  })
  /** The bound `recordTail` records for a result: this strategy's own spill, its preview cut at `chars`. */
  const bound = (seq: number, of: LogEntry, chars: number): LogEntry => at(seq, of.turn, {
    _tag: "Compaction", strategy: WINDOW_STRATEGY.id, version: WINDOW_STRATEGY.version,
    action: { _tag: "Spill", entry: of.id, preview: spillPreview(of, of.body._tag === "ToolResult" ? of.body.view : "", chars) },
  })
  const recorded = (seq: number, turn: number, actions: ReadonlyArray<CompactionAction>): ReadonlyArray<LogEntry> =>
    actions.map((action, index) => at(seq + index, turn, { _tag: "Compaction", strategy: WINDOW_STRATEGY.id, version: WINDOW_STRATEGY.version, action }))
  const renderOf = (turn: number) => (all: ReadonlyArray<LogEntry>) => renderLog(all, { ...window.render, strategy: WINDOW_STRATEGY.id, currentTurn: turn, currentRun: run(turn), run: RunOrdinal.make(0), stepContext: "none" })
  const spilled = (actions: ReadonlyArray<CompactionAction>) => actions.flatMap((action) => action._tag === "Spill" ? [String(action.entry)] : [])

  test("a bounded result is spilled again only under pressure, largest shown first", async () => {
    // The largest view shows the least: it was bounded at 400 characters. The middle one was bounded at 1,000; the smallest is whole.
    const [largest, middle, whole] = [result(2, 1, "a".repeat(5_000)), result(5, 1, "c".repeat(3_000)), result(8, 1, "b".repeat(1_500))]
    const all = [
      at(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "read all three" }) }),
      call(1, 1), largest, bound(3, largest, 400), call(4, 1), middle, bound(6, middle, 1_000), call(7, 1), whole,
    ]
    const render = renderOf(1)
    const tokensWith = (actions: ReadonlyArray<CompactionAction>) => estimateMessageTokens(render([...all, ...actions.map((action, index) => pendingCompaction(window.strategy, action, index))]))
    const maintain = (entries: ReadonlyArray<LogEntry>, budgetTokens: number) =>
      Effect.runPromise(window.maintain({ entries, signal: { ...signal, phase: "step", budgetTokens }, turn: 1, runId: run(1), render })).then((decided) => decided.actions)
    const spill = (of: LogEntry): CompactionAction => ({ _tag: "Spill", entry: of.id, preview: spillPreview(of, of.body._tag === "ToolResult" ? of.body.view : "", options.previewChars) })

    // Within the budget the bounds stand: a bounded result is not shortened further.
    expect(await maintain(all, tokensWith([]))).toEqual([])
    // One token over, the result showing the most text goes first: the whole one, though its view is the smallest.
    expect(await maintain(all, tokensWith([]) - 1)).toEqual([spill(whole)])
    // Then the others, in the order of what they show, never of the views behind them.
    expect(spilled(await maintain(all, tokensWith([spill(whole)]) - 1))).toEqual([String(whole.id), String(middle.id)])
    const every = await maintain(all, tokensWith([spill(whole), spill(middle)]) - 1)
    expect(every).toEqual([spill(whole), spill(middle), spill(largest)])
    // What is recorded is not decided again: no preview would be shorter than the one each result now shows.
    const after = [...all, ...recorded(9, 1, every)]
    expect(await maintain(after, estimateMessageTokens(render(after)))).toEqual([])
    expect(await Effect.runPromise(Effect.result(window.maintain({ entries: after, signal: { ...signal, phase: "step", budgetTokens: estimateMessageTokens(render(after)) - 1 }, turn: 1, runId: run(1), render }))))
      .toMatchObject({ _tag: "Failure", failure: { code: "context.budget" } })
  })

  test("a bounded result takes its compact view only when shorter", async () => {
    // Turn 1 read three results: two bounded at 1,000 characters as they were written, one short enough to stay whole.
    const [short, long, whole] = [result(2, 1, "s".repeat(3_000)), result(5, 1, "l".repeat(3_000)), result(8, 1, "w".repeat(300))]
    const all = [
      at(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "read all three" }) }),
      call(1, 1), short, bound(3, short, 1_000), call(4, 1), long, bound(6, long, 1_000), call(7, 1), whole,
      at(9, 1, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("read") }),
      at(10, 2, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "and now?" }) }),
    ]
    const compactOf: Readonly<Record<string, string>> = { s: "(short: 3000 s)", l: `(long: ${"L".repeat(2_000)})`, w: `(whole, compact and longer: ${"W".repeat(400)})` }
    const asked: Array<string> = []
    const views: MaintainSignal["views"] = { ...signal.views, compact: (_tool, encoded) => Effect.sync(() => {
      const key = String(encoded).charAt(0)
      asked.push(key)
      return Option.fromNullishOr(compactOf[key])
    }) }
    const turnStart = (entries: ReadonlyArray<LogEntry>) =>
      Effect.runPromise(window.maintain({ entries, signal: { ...signal, phase: "turn-start", budgetTokens: 100_000, views }, turn: 2, runId: run(2), render: renderOf(2) })).then((decided) => decided.actions)

    const first = await turnStart(all)
    // The bounded result whose compact view is shorter takes it; the one whose compact view is longer keeps its preview.
    // A result still shown whole takes its compact view whatever its length, as before.
    expect(first).toEqual([{ _tag: "CompactViews", entries: [short.id, whole.id], texts: [compactOf.s!, compactOf.w!] }])
    expect(asked).toEqual(["s", "l", "w"])
    const shown = JSON.stringify(renderOf(2)([...all, ...recorded(11, 2, first)]))
    expect(shown).toContain(compactOf.s!)
    expect(shown).toContain(`${"l".repeat(1_000)}\\n[… 2000 more characters kept out of context`)
    // A later turn start decides nothing more, and asks again only for the result still shown through a preview.
    asked.length = 0
    expect(await turnStart([...all, ...recorded(11, 2, first)])).toEqual([])
    expect(asked).toEqual(["l"])
  })
})
