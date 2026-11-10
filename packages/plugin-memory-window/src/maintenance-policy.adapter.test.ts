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
  /** What a maintenance decided: its actions, or the code it failed with. */
  const decisionOf = (decision: Effect.Effect<{ readonly actions: ReadonlyArray<CompactionAction> }, { readonly code: string }>) =>
    Effect.runPromise(Effect.match(decision, { onSuccess: (made): ReadonlyArray<CompactionAction> | string => made.actions, onFailure: (error) => `failed with ${error.code}` }))

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

  test("a result shown through its digest is spilled only when the pressure preview is shorter than the digest", async () => {
    // Two results of 3,000 characters, each digested as it was written: one digest is shorter than a pressure preview, one longer.
    const [brief, lengthy] = [result(2, 1, "a".repeat(3_000)), result(5, 1, "b".repeat(3_000))]
    const digest = (seq: number, of: LogEntry, text: string): LogEntry => at(seq, 1, { _tag: "ToolDigest", entry: of.id, version: "1", mode: "summarize", keep: [], text, digester: "fixed@1", trigger: "write" })
    const all = [
      at(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "read both" }) }),
      call(1, 1), brief, digest(3, brief, "a brief digest"), call(4, 1), lengthy, digest(6, lengthy, `a lengthy digest ${"d".repeat(1_000)}`),
    ]
    const spill = (of: LogEntry): CompactionAction => ({ _tag: "Spill", entry: of.id, preview: spillPreview(of, of.body._tag === "ToolResult" ? of.body.view : "", options.previewChars) })
    /** What `policy` decides over the log at a budget `under` tokens below what `actions` leave, at a step and at the turn's end. */
    const decided = (policy: MemoryPolicy, actions: ReadonlyArray<CompactionAction>, under: number, phase: MaintainSignal["phase"] = "step") => {
      const render = (entries: ReadonlyArray<LogEntry>) => renderLog(entries, { ...policy.render, strategy: WINDOW_STRATEGY.id, currentTurn: 1, currentRun: run(1), run: RunOrdinal.make(0), stepContext: "none" })
      const budgetTokens = estimateMessageTokens(render([...all, ...actions.map((action, index) => pendingCompaction(policy.strategy, action, index))])) - under
      return decisionOf(policy.maintain({ entries: all, signal: { ...signal, phase, budgetTokens }, turn: 1, runId: run(1), render }))
    }
    expect(spillPreview(brief, "a".repeat(3_000), options.previewChars).length).toBeGreaterThan("a brief digest".length)
    // Within the budget nothing is decided. One token over, only the result whose digest is longer than a preview is spilled.
    expect(await decided(window, [], 0)).toEqual([])
    expect(await decided(window, [], 1)).toEqual([spill(lengthy)])
    // The brief digest is never replaced by a longer preview: with nothing left to spill, a step fails and a turn's end keeps the one spill.
    expect(await decided(window, [spill(lengthy)], 1)).toBe("failed with context.budget")
    expect(await decided(window, [spill(lengthy)], 1, "turn-end")).toEqual([spill(lengthy)])
    // A window that shows no digests shows both views whole: both are candidates, by the view each shows, in the order they were written.
    const withoutDigests = windowPolicy({ ...options, digests: false })
    expect(await decided(withoutDigests, [], 1)).toEqual([spill(brief)])
    expect(await decided(withoutDigests, [spill(brief)], 1)).toEqual([spill(brief), spill(lengthy)])
  })

  test("currentTurnFirst drops earlier turns before it spills a bounded result again, and then spills the one showing the most first", async () => {
    const currentFirst = windowPolicy({ ...options, currentTurnFirst: true })
    // Turn 1 read one result. Turn 2, the current one, read two: the larger was bounded at 1,000 characters as it was written, the smaller is whole.
    const [earlier, bounded, whole] = [result(2, 1, "x".repeat(3_000)), result(6, 2, "a".repeat(5_000)), result(9, 2, "b".repeat(1_500))]
    const all = [
      at(0, 1, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "first question" }) }), call(1, 1), earlier,
      at(3, 1, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("first answer") }),
      at(4, 2, { _tag: "TurnStarted", userMessage: new UserMessage({ text: "second question" }) }),
      call(5, 2), bounded, { ...bound(7, bounded, 1_000), body: { ...bound(7, bounded, 1_000).body, version: currentFirst.strategy.version } }, call(8, 2), whole,
    ]
    const render = (entries: ReadonlyArray<LogEntry>) => renderLog(entries, { ...currentFirst.render, strategy: WINDOW_STRATEGY.id, currentTurn: 2, currentRun: run(2), run: RunOrdinal.make(0), stepContext: "none" })
    const tokensWith = (entries: ReadonlyArray<LogEntry>, actions: ReadonlyArray<CompactionAction>) => estimateMessageTokens(render([...entries, ...actions.map((action, index) => pendingCompaction(currentFirst.strategy, action, index))]))
    const maintain = (entries: ReadonlyArray<LogEntry>, budgetTokens: number) =>
      decisionOf(currentFirst.maintain({ entries, signal: { ...signal, phase: "step", budgetTokens }, turn: 2, runId: run(2), render }))
    const spill = (of: LogEntry): CompactionAction => ({ _tag: "Spill", entry: of.id, preview: spillPreview(of, of.body._tag === "ToolResult" ? of.body.view : "", options.previewChars) })
    const dropTurn1: CompactionAction = { _tag: "DropTurns", throughTurn: 1, ledger: ledgerOf(all, 1, options.ledgerTurnChars) }

    // One token over: the earlier turn goes, and the bounded result keeps the preview it was written with.
    expect(await maintain(all, tokensWith(all, []) - 1)).toEqual([dropTurn1])
    // The current turn alone does not fit: the result showing the most text is spilled first, the whole one, though its view is the smaller.
    expect(await maintain(all, tokensWith(all, [dropTurn1]) - 1)).toEqual([spill(whole), dropTurn1])
    // Then the bounded one, again, to the shorter pressure preview.
    const every = [spill(whole), spill(bounded), dropTurn1]
    expect(await maintain(all, tokensWith(all, [spill(whole), dropTurn1]) - 1)).toEqual(every)
    // What is recorded is not decided again, and nothing is left to shorten after it.
    const after = [...all, ...every.map((action, index) => at(10 + index, 2, { _tag: "Compaction", strategy: currentFirst.strategy.id, version: currentFirst.strategy.version, action }))]
    expect(await maintain(after, estimateMessageTokens(render(after)))).toEqual([])
    expect(await maintain(after, estimateMessageTokens(render(after)) - 1)).toBe("failed with context.budget")
  })
})

describe("compact views under pressure", () => {
  // A host that keeps its provider's prompt cache: no earlier turn is rewritten when a turn starts.
  const options = { ...memoryWindowDefaults, compactPreviousTurn: false, spillMinChars: 100, previewChars: 20, ledgerTurnChars: 40, media: "none" as const }
  const cacheFirst = windowPolicy(options)
  const currentFirst = windowPolicy({ ...options, currentTurnFirst: true })
  const run = (turn: number) => RunId.make(`run-${turn}`)
  const at = (seq: number, turn: number, body: LogBody): LogEntry => ({ id: entryId(run(turn), seq), runId: run(turn), turn, step: 0, at: seq, body })
  const call = (seq: number, turn: number, toolName = "lookup"): LogEntry => at(seq, turn, { _tag: "Message", message: { role: "assistant", content: [{ type: "tool-call", toolCallId: ToolCallId.make(`c${seq + 1}`), toolName, input: {} }] } })
  const result = (seq: number, turn: number, view: string, more: { readonly toolName?: string; readonly pinned?: boolean } = {}): LogEntry => at(seq, turn, {
    _tag: "ToolResult", toolCallId: ToolCallId.make(`c${seq}`), toolName: more.toolName ?? "lookup", isError: false, encoded: view, view, viewVersion: "1", subjects: [], artifacts: [], pinned: more.pinned ?? false,
  })
  const asks = (seq: number, turn: number, text: string): LogEntry => at(seq, turn, { _tag: "TurnStarted", userMessage: new UserMessage({ text }) })
  const replies = (seq: number, turn: number, text: string): LogEntry => at(seq, turn, { _tag: "TurnEnded", outcome: "completed", reply: Option.some(text) })
  const viewOf = (entry: LogEntry): string => entry.body._tag === "ToolResult" ? entry.body.view : ""

  /** `lookup`'s compact view: what was read and how long it was. */
  const compactOf = (view: string): string => `(${view.charAt(0)}: ${view.length} characters)`
  /** The compact view of each tool that has one: `halved`'s is half its view, `echoed`'s is its view, `padded`'s is longer than its view. A tool the record lacks has none. */
  const compactViews: Readonly<Record<string, (view: string) => string>> = {
    lookup: compactOf, halved: (view) => view.slice(0, view.length / 2), echoed: (view) => view, padded: (view) => `${view} (as it was read)`,
  }
  const compacting = (...of: ReadonlyArray<LogEntry>): CompactionAction => ({ _tag: "CompactViews", entries: of.map((entry) => entry.id), texts: of.map((entry) => compactOf(viewOf(entry))) })
  const spill = (of: LogEntry): CompactionAction => ({ _tag: "Spill", entry: of.id, preview: spillPreview(of, viewOf(of), options.previewChars) })
  const recorded = (seq: number, turn: number, actions: ReadonlyArray<CompactionAction>): ReadonlyArray<LogEntry> =>
    actions.map((action, index) => at(seq + index, turn, { _tag: "Compaction", strategy: WINDOW_STRATEGY.id, version: WINDOW_STRATEGY.version, action }))
  const renderOf = (turn: number) => (all: ReadonlyArray<LogEntry>) => renderLog(all, { ...cacheFirst.render, strategy: WINDOW_STRATEGY.id, currentTurn: turn, currentRun: run(turn), run: RunOrdinal.make(0), stepContext: "none" })
  /** The tokens of the request of `turn` once `actions` apply. */
  const tokensAfter = (entries: ReadonlyArray<LogEntry>, turn: number, actions: ReadonlyArray<CompactionAction>) =>
    estimateMessageTokens(renderOf(turn)([...entries, ...actions.map((action, index) => pendingCompaction(WINDOW_STRATEGY, action, index))]))
  /** What `policy` decides in `turn` at `budgetTokens` (its actions, or the code it failed with), and the first character of each result it asked a compact view for. */
  const decide = async (policy: MemoryPolicy, entries: ReadonlyArray<LogEntry>, turn: number, budgetTokens: number, phase: MaintainSignal["phase"] = "step") => {
    const asked: Array<string> = []
    const views: MaintainSignal["views"] = { ...signal.views, compact: (tool, encoded) => Effect.sync(() => {
      asked.push(String(encoded).charAt(0))
      return Option.map(Option.fromNullishOr(compactViews[tool]), (compact) => compact(String(encoded)))
    }) }
    const decision = await Effect.runPromise(Effect.match(policy.maintain({ entries, signal: { ...signal, phase, budgetTokens, views }, turn, runId: run(turn), render: renderOf(turn) }), {
      onSuccess: (made): ReadonlyArray<CompactionAction> | string => made.actions, onFailure: (error) => `failed with ${error.code}`,
    }))
    return { decision, asked }
  }

  /** Turn 1 read `first`, turn 2 read `second`, and turn 3, the current one, read `current`. No turn start compacted anything. */
  const [first, second, current] = [result(2, 1, "a".repeat(2_000)), result(6, 2, "b".repeat(4_000)), result(10, 3, "c".repeat(3_000))]
  const conversation: ReadonlyArray<LogEntry> = [
    asks(0, 1, "first question"), call(1, 1), first, replies(3, 1, "first answer"),
    asks(4, 2, "second question"), call(5, 2), second, replies(7, 2, "second answer"),
    asks(8, 3, "third question"), call(9, 3), current,
  ]
  const fits = tokensAfter(conversation, 3, [])
  const drop = (through: number): CompactionAction => ({ _tag: "DropTurns", throughTurn: through, ledger: ledgerOf(conversation, through, options.ledgerTurnChars) })

  test("over budget with compactPreviousTurn off, an earlier turn's result takes its compact view and nothing is spilled or dropped", async () => {
    // One token over: under either order the compact view of one earlier result is enough, so the current turn's result stays whole and every turn stays.
    expect(await decide(cacheFirst, conversation, 3, fits - 1)).toEqual({ decision: [compacting(second)], asked: ["a", "b"] })
    expect(await decide(currentFirst, conversation, 3, fits - 1)).toEqual({ decision: [compacting(second)], asked: ["a", "b"] })
    // A run's first request is fitted the same way.
    expect(await decide(cacheFirst, conversation, 3, fits - 1, "turn-start")).toEqual({ decision: [compacting(second)], asked: ["a", "b"] })
    const shown = JSON.stringify(renderOf(3)([...conversation, ...recorded(11, 3, [compacting(second)])]))
    expect(shown).toContain(compactOf(viewOf(second)))
    expect(shown).toContain(viewOf(first))
    expect(shown).toContain(viewOf(current))
  })

  test("under budget with compactPreviousTurn off, nothing is decided and no compact view is asked for, at any phase", async () => {
    const phases: ReadonlyArray<MaintainSignal["phase"]> = ["turn-start", "step", "turn-end", "overflow"]
    for (const phase of phases) expect(await decide(cacheFirst, conversation, 3, fits, phase)).toEqual({ decision: [], asked: [] })
    expect(await decide(currentFirst, conversation, 3, fits)).toEqual({ decision: [], asked: [] })
  })

  test("only as many earlier results are compacted as the budget needs, the one that saves the most first", async () => {
    // The larger result of turn 2 goes first, though turn 1 is older.
    expect((await decide(cacheFirst, conversation, 3, fits - 1)).decision).toEqual([compacting(second)])
    expect((await decide(cacheFirst, conversation, 3, tokensAfter(conversation, 3, [compacting(second)]))).decision).toEqual([compacting(second)])
    // One token under what that leaves, the other follows, in the same action.
    expect((await decide(cacheFirst, conversation, 3, tokensAfter(conversation, 3, [compacting(second)]) - 1)).decision).toEqual([compacting(second, first)])
  })

  test("the default order compacts earlier turns, then spills the current turn's results, then drops the oldest turns", async () => {
    const every = compacting(second, first)
    const under = (actions: ReadonlyArray<CompactionAction>) => tokensAfter(conversation, 3, actions) - 1
    expect((await decide(cacheFirst, conversation, 3, under([every]))).decision).toEqual([every, spill(current)])
    // A dropped turn's result keeps no compact view in the decision: it is not shown.
    expect((await decide(cacheFirst, conversation, 3, under([every, spill(current)]))).decision).toEqual([compacting(second), spill(current), drop(1)])
    expect((await decide(cacheFirst, conversation, 3, under([every, spill(current), drop(1)]))).decision).toEqual([spill(current), drop(2)])
    // Nothing is left to shorten: a step fails, and a turn's end keeps every reduction.
    expect((await decide(cacheFirst, conversation, 3, under([every, spill(current), drop(2)]))).decision).toBe("failed with context.budget")
    expect((await decide(cacheFirst, conversation, 3, under([every, spill(current), drop(2)]), "turn-end")).decision).toEqual([spill(current), drop(2)])
  })

  test("currentTurnFirst compacts earlier turns, then drops the oldest turns, then spills the current turn's results", async () => {
    const every = compacting(second, first)
    const under = (actions: ReadonlyArray<CompactionAction>) => tokensAfter(conversation, 3, actions) - 1
    // A dropped turn's result keeps no compact view in the decision: it is not shown.
    expect((await decide(currentFirst, conversation, 3, under([every]))).decision).toEqual([compacting(second), drop(1)])
    expect((await decide(currentFirst, conversation, 3, under([every, drop(1)]))).decision).toEqual([drop(2)])
    // The current turn alone does not fit: its result is spilled, and the earlier turns the budget then holds are kept, compact.
    expect((await decide(currentFirst, conversation, 3, under([every, drop(2)]))).decision).toEqual([every, spill(current)])
    expect((await decide(currentFirst, conversation, 3, under([every, spill(current)]))).decision).toEqual([compacting(second), spill(current), drop(1)])
    expect((await decide(currentFirst, conversation, 3, under([every, spill(current), drop(2)]))).decision).toBe("failed with context.budget")
  })

  test("the current turn's results are never compacted: under pressure they are spilled", async () => {
    // One turn, two results of a tool that has a compact view.
    const [larger, smaller] = [result(2, 1, "c".repeat(3_000)), result(4, 1, "d".repeat(2_000))]
    const turn = [asks(0, 1, "read both"), call(1, 1), larger, call(3, 1), smaller]
    expect(await decide(cacheFirst, turn, 1, tokensAfter(turn, 1, []) - 1)).toEqual({ decision: [spill(larger)], asked: [] })
    expect(await decide(currentFirst, turn, 1, tokensAfter(turn, 1, []) - 1)).toEqual({ decision: [spill(larger)], asked: [] })
    // With earlier turns to compact, the current turn's result is still not asked for.
    expect((await decide(cacheFirst, conversation, 3, tokensAfter(conversation, 3, [compacting(second, first)]) - 1)).asked).toEqual(["a", "b"])
  })

  test("a result whose compact view is not shorter than its view is left alone, and so is a tool with no compact view", async () => {
    // Turn 1 read four results of 3,000 characters: one whose compact view is short, one whose compact view is its view, one whose compact view is longer, one of a tool with none.
    const [short, same, longer, none] = [
      result(2, 1, "s".repeat(3_000)), result(4, 1, "e".repeat(3_000), { toolName: "echoed" }), result(6, 1, "p".repeat(3_000), { toolName: "padded" }), result(8, 1, "n".repeat(3_000), { toolName: "plain" }),
    ]
    const latest = result(12, 2, "c".repeat(3_000))
    const all = [
      asks(0, 1, "read all four"), call(1, 1), short, call(3, 1, "echoed"), same, call(5, 1, "padded"), longer, call(7, 1, "plain"), none, replies(9, 1, "read"),
      asks(10, 2, "and one more"), call(11, 2), latest,
    ]
    expect(await decide(cacheFirst, all, 2, tokensAfter(all, 2, []) - 1)).toEqual({ decision: [compacting(short)], asked: ["s", "e", "p", "n"] })
    // The other three keep their views whatever the pressure: the next step spills the current turn's result.
    expect(await decide(cacheFirst, all, 2, tokensAfter(all, 2, [compacting(short)]) - 1)).toEqual({ decision: [compacting(short), spill(latest)], asked: ["s", "e", "p", "n"] })
    const shown = JSON.stringify(renderOf(2)([...all, ...recorded(13, 2, [compacting(short), spill(latest)])]))
    expect([same, longer, none].every((kept) => shown.includes(viewOf(kept)))).toBe(true)
  })

  test("of several earlier results, the fewest whose compact views fit are compacted, in the order of what each saves", async () => {
    // Turn 1 read five results of 1,000 to 5,000 characters, in no order of size.
    const read = [1_000, 5_000, 3_000, 2_000, 4_000].map((size, index) => result(2 + index * 2, 1, "fghij".charAt(index).repeat(size)))
    const all = [asks(0, 1, "read all five"), ...read.flatMap((entry, index) => [call(1 + index * 2, 1), entry]), replies(11, 1, "read"), asks(12, 2, "and now?")]
    const bySaving = read.toSorted((left, right) => viewOf(right).length - viewOf(left).length)
    for (const count of [1, 2, 3, 4, 5]) {
      // A budget that the `count` largest savings just meet takes exactly those, and one fewer would not fit.
      const taken = compacting(...bySaving.slice(0, count))
      expect(tokensAfter(all, 2, [taken])).toBeLessThan(tokensAfter(all, 2, [compacting(...bySaving.slice(0, count - 1))]))
      expect(await decide(cacheFirst, all, 2, tokensAfter(all, 2, [taken]))).toEqual({ decision: [taken], asked: ["f", "g", "h", "i", "j"] })
    }
  })

  test("a bounded or digested result takes its compact view only when that is shorter than the text it shows, and a pinned result keeps its view", async () => {
    const bound = (seq: number, of: LogEntry, chars: number): LogEntry => at(seq, of.turn, { _tag: "Compaction", strategy: WINDOW_STRATEGY.id, version: WINDOW_STRATEGY.version, action: { _tag: "Spill", entry: of.id, preview: spillPreview(of, viewOf(of), chars) } })
    const digest = (seq: number, of: LogEntry, text: string): LogEntry => at(seq, of.turn, { _tag: "ToolDigest", entry: of.id, version: "1", mode: "summarize", keep: [], text, digester: "fixed@1", trigger: "write" })
    // Two results of 3,000 characters whose compact view is 1,500: one bounded at 2,000 as it was written, one at 1,000.
    const [wide, narrow] = [result(2, 1, "w".repeat(3_000), { toolName: "halved" }), result(5, 1, "n".repeat(3_000), { toolName: "halved" })]
    // Two digested as they were written: one digest is 1,000 characters, one is shorter than the compact view.
    const [lengthy, brief] = [result(8, 1, "l".repeat(3_000)), result(11, 1, "b".repeat(3_000))]
    const pinned = result(14, 1, "k".repeat(3_000), { pinned: true })
    const all = [
      asks(0, 1, "read all five"),
      call(1, 1, "halved"), wide, bound(3, wide, 2_000), call(4, 1, "halved"), narrow, bound(6, narrow, 1_000),
      call(7, 1), lengthy, digest(9, lengthy, `a lengthy digest ${"d".repeat(1_000)}`), call(10, 1), brief, digest(12, brief, "a brief digest"),
      call(13, 1), pinned, replies(15, 1, "read"),
      asks(16, 2, "and now?"),
    ]
    expect("a brief digest".length).toBeLessThan(compactOf(viewOf(brief)).length)
    // The digested result saves the most, then the one bounded at 2,000. The budget needs both and asks nothing more of the other three.
    const taken: CompactionAction = { _tag: "CompactViews", entries: [lengthy.id, wide.id], texts: [compactOf(viewOf(lengthy)), "w".repeat(1_500)] }
    expect(await decide(cacheFirst, all, 2, tokensAfter(all, 2, [taken]))).toEqual({ decision: [taken], asked: ["w", "n", "l", "b"] })
    // Nothing else of turn 1 can be shortened without dropping the turn, and a dropped turn's results keep no compact view in the decision.
    expect((await decide(cacheFirst, all, 2, tokensAfter(all, 2, [taken]) - 1)).decision).toEqual([{ _tag: "DropTurns", throughTurn: 1, ledger: ledgerOf(all, 1, options.ledgerTurnChars) }])
  })

  test("a compact view recorded under pressure is not decided again, and its result is not asked for again", async () => {
    const after = [...conversation, ...recorded(11, 3, [compacting(second)])]
    expect(await decide(cacheFirst, after, 3, tokensAfter(after, 3, []))).toEqual({ decision: [], asked: [] })
    expect(await decide(cacheFirst, after, 3, tokensAfter(after, 3, []) - 1)).toEqual({ decision: [compacting(first)], asked: ["a"] })
  })

  test("a result of a turn already dropped is not compacted: it is not shown", async () => {
    const after = [...conversation, ...recorded(11, 3, [drop(1)])]
    expect(JSON.stringify(renderOf(3)(after))).not.toContain(viewOf(first))
    expect(await decide(cacheFirst, after, 3, tokensAfter(after, 3, []) - 1)).toEqual({ decision: [compacting(second)], asked: ["b"] })
    expect(await decide(cacheFirst, after, 3, tokensAfter(after, 3, [compacting(second)]) - 1)).toEqual({ decision: [compacting(second), spill(current)], asked: ["b"] })
  })

  test("with compactPreviousTurn on, a turn start over budget asks each earlier result once and compacts them all, as before", async () => {
    const compactAtStart = windowPolicy({ ...options, compactPreviousTurn: true })
    // Under budget every earlier result takes its compact view, in the order of the log.
    expect(await decide(compactAtStart, conversation, 3, fits, "turn-start")).toEqual({ decision: [compacting(first, second)], asked: ["a", "b"] })
    // Over budget after that, the current turn's result is spilled; no result is asked a second time.
    expect(await decide(compactAtStart, conversation, 3, tokensAfter(conversation, 3, [compacting(first, second)]) - 1, "turn-start"))
      .toEqual({ decision: [compacting(first, second), spill(current)], asked: ["a", "b"] })
  })

  test("a compact view of a result in a turn the same decision drops is not recorded: no request would show it", async () => {
    const every = compacting(second, first)
    const under = (actions: ReadonlyArray<CompactionAction>) => tokensAfter(conversation, 3, actions) - 1
    const requestAfter = (actions: ReadonlyArray<CompactionAction>) => renderOf(3)([...conversation, ...recorded(11, 3, actions)])
    // Both compact views and the spill do not fit, so turn 1 is dropped: the decision keeps the compact view of turn 2's result only.
    expect(await decide(cacheFirst, conversation, 3, under([every, spill(current)]))).toEqual({ decision: [compacting(second), spill(current), drop(1)], asked: ["a", "b"] })
    // The request is the one the compact view of the dropped turn's result would have left.
    expect(requestAfter([compacting(second), spill(current), drop(1)])).toEqual(requestAfter([every, spill(current), drop(1)]))
    expect(JSON.stringify(requestAfter([every, spill(current), drop(1)]))).not.toContain(compactOf(viewOf(first)))
    // With both earlier turns dropped no compact view is left, and no empty action is recorded in their place.
    expect((await decide(cacheFirst, conversation, 3, under([every, spill(current), drop(1)]))).decision).toEqual([spill(current), drop(2)])
    expect(requestAfter([spill(current), drop(2)])).toEqual(requestAfter([every, spill(current), drop(2)]))
    // The same where currentTurnFirst drops before it spills, and at a turn's end, which keeps the smallest reduction.
    expect((await decide(currentFirst, conversation, 3, under([every]))).decision).toEqual([compacting(second), drop(1)])
    expect((await decide(currentFirst, conversation, 3, under([every, drop(1)]))).decision).toEqual([drop(2)])
    expect((await decide(cacheFirst, conversation, 3, 5, "turn-end")).decision).toEqual([spill(current), drop(2)])
  })

  test("with compactPreviousTurn on, a turn start that drops a turn records no compact view of its results, and a later turn start asks for none", async () => {
    const compactAtStart = windowPolicy({ ...options, compactPreviousTurn: true })
    // The turn start compacts both earlier results, and the budget still needs the spill and turn 1 dropped.
    const started = await decide(compactAtStart, conversation, 3, tokensAfter(conversation, 3, [compacting(first, second), spill(current)]) - 1, "turn-start")
    expect(started).toEqual({ decision: [compacting(second), spill(current), drop(1)], asked: ["a", "b"] })
    // Turn 4 starts over that log: turn 1's result is not asked again, and takes no compact view no request would show.
    const next = [...conversation, ...recorded(11, 3, [compacting(second), spill(current), drop(1)]), replies(14, 3, "third answer"), asks(15, 4, "fourth question")]
    expect(await decide(compactAtStart, next, 4, 100_000, "turn-start")).toEqual({ decision: [compacting(current)], asked: ["c"] })
    expect(await decide(cacheFirst, next, 4, tokensAfter(next, 4, []) - 1)).toEqual({ decision: [compacting(current)], asked: ["c"] })
  })

  describe("a compact view is taken only when the request's estimate falls with it", () => {
    /** A compact view one character shorter than its view, all quotes and newlines: each takes two characters of the request's JSON. */
    const escaped = (view: string): string => "\"\n".repeat(view.length).slice(0, view.length - 1)
    /** The compact view of each tool here: `escaped`'s, and one that cuts a fixed number of characters off the end of its view. */
    const cutting: Readonly<Record<string, (view: string) => string>> = {
      escaped, "cut-2": (view) => view.slice(0, -2), "cut-3": (view) => view.slice(0, -3),
    }
    /** What `cacheFirst` decides in turn 2 at `budgetTokens`, and the first character of each result it asked a compact view for. */
    const decideOver = async (entries: ReadonlyArray<LogEntry>, budgetTokens: number) => {
      const asked: Array<string> = []
      const views: MaintainSignal["views"] = { ...signal.views, compact: (tool, encoded) => Effect.sync(() => {
        asked.push(String(encoded).charAt(0))
        return Option.map(Option.fromNullishOr(cutting[tool]), (compact) => compact(String(encoded)))
      }) }
      const decision = await Effect.runPromise(Effect.match(cacheFirst.maintain({ entries, signal: { ...signal, phase: "step", budgetTokens, views }, turn: 2, runId: run(2), render: renderOf(2) }), {
        onSuccess: (made): ReadonlyArray<CompactionAction> | string => made.actions, onFailure: (error) => `failed with ${error.code}`,
      }))
      return { decision, asked }
    }
    const taking = (tool: string, ...of: ReadonlyArray<LogEntry>): CompactionAction =>
      ({ _tag: "CompactViews", entries: of.map((entry) => entry.id), texts: of.map((entry) => cutting[tool]!(viewOf(entry))) })

    test("a compact view shorter in characters that takes more of the request is left alone, and the decision is the one without it", async () => {
      // Turn 1 read three results whose compact views are one character shorter and twice as heavy in the request; turn 2 read one more.
      const read = ["q", "r", "s"].map((letter, index) => result(2 + index * 2, 1, letter.repeat(900), { toolName: "escaped" }))
      const latest = result(10, 2, "c".repeat(3_000))
      const all = [
        asks(0, 1, "read all three"), ...read.flatMap((entry, index) => [call(1 + index * 2, 1, "escaped"), entry]), replies(7, 1, "read"),
        asks(8, 2, "and one more"), call(9, 2), latest,
      ]
      for (const entry of read) {
        expect(escaped(viewOf(entry)).length).toBe(viewOf(entry).length - 1)
        expect(tokensAfter(all, 2, [taking("escaped", entry)])).toBeGreaterThan(tokensAfter(all, 2, []))
      }
      // One token over: every compact view is asked for, none is taken, and the current turn's result is spilled as if the tool had none.
      expect(await decideOver(all, tokensAfter(all, 2, []) - 1)).toEqual({ decision: [spill(latest)], asked: ["q", "r", "s"] })
    })

    test("a compact view that frees less than one token of the estimate is left alone, whatever else its message holds", async () => {
      // Views of 300, 301 and 302 characters put their message's JSON at each remainder of a token.
      const lengths = [300, 301, 302]
      const logOf = (tool: string, length: number) => {
        const earlier = result(2, 1, "v".repeat(length), { toolName: tool })
        const latest = result(6, 2, "c".repeat(3_000))
        return { earlier, latest, all: [asks(0, 1, "read it"), call(1, 1, tool), earlier, replies(3, 1, "read"), asks(4, 2, "and one more"), call(5, 2), latest] }
      }
      // Three characters less lower the estimate at every remainder: the compact view is taken, and it is enough for a budget one token under.
      for (const length of lengths) {
        const { earlier, all } = logOf("cut-3", length)
        expect(tokensAfter(all, 2, []) - tokensAfter(all, 2, [taking("cut-3", earlier)])).toBe(1)
        expect(await decideOver(all, tokensAfter(all, 2, []) - 1)).toEqual({ decision: [taking("cut-3", earlier)], asked: ["v"] })
      }
      // Two characters less lower it at some remainders only, so the view is not taken at any: the current turn's result is spilled.
      const falls = lengths.map((length) => {
        const { earlier, all } = logOf("cut-2", length)
        return tokensAfter(all, 2, []) - tokensAfter(all, 2, [taking("cut-2", earlier)])
      })
      expect(falls.toSorted((left, right) => left - right)).toEqual([0, 1, 1])
      for (const length of lengths) {
        const { latest, all } = logOf("cut-2", length)
        expect(await decideOver(all, tokensAfter(all, 2, []) - 1)).toEqual({ decision: [spill(latest)], asked: ["v"] })
      }
    })

    test("a compact view longer in characters than what is shown is still left alone, though it would take less of the request", async () => {
      // The view is 400 newlines, 800 characters of the request's JSON; its compact view is 500 plain characters, which the model would read as more.
      const earlier = result(2, 1, "\n".repeat(400), { toolName: "plain-500" })
      const latest = result(6, 2, "c".repeat(3_000))
      const all = [asks(0, 1, "read it"), call(1, 1, "plain-500"), earlier, replies(3, 1, "read"), asks(4, 2, "and one more"), call(5, 2), latest]
      const longer: CompactionAction = { _tag: "CompactViews", entries: [earlier.id], texts: ["p".repeat(500)] }
      const views: MaintainSignal["views"] = { ...signal.views, compact: () => Effect.succeed(Option.some("p".repeat(500))) }
      expect(tokensAfter(all, 2, [longer])).toBeLessThan(tokensAfter(all, 2, []))
      const decided = await Effect.runPromise(cacheFirst.maintain({ entries: all, signal: { ...signal, phase: "step", budgetTokens: tokensAfter(all, 2, []) - 1, views }, turn: 2, runId: run(2), render: renderOf(2) }))
      expect(decided.actions).toEqual([spill(latest)])
    })
  })
})
