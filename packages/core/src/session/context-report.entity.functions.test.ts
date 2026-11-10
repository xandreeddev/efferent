import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { ConversationId, ToolCallId } from "../domain/message.entity.js"
import { ModelCallData, ModelCallId } from "../domain/model-call.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { tokenUsage } from "../domain/token-usage.entity.functions.js"
import { harnessCodeOf } from "../harness/harness-code.entity.functions.js"
import { canonicalJson, entryId } from "../memory/memory-log.entity.functions.js"
import type { EntryId, LogBody } from "../memory/memory-log.entity.js"
import type { ModelRequestHeader, ModelRequestTool } from "../turn/model-request.entity.js"
import { hostNote } from "../turn/model-text.js"
import { prepareRequestParts } from "../turn/request-part.entity.functions.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { contextReportOf } from "./context-report.entity.functions.js"
import { ContextReport } from "./context-report.entity.js"
import { draftOfEntry, turnStartedDraft } from "./session-event.entity.functions.js"
import { storedJson } from "./session-log.entity.functions.js"
import type { JsonObject, SessionDraft, SessionLogEvent } from "./session-log.entity.js"

/*
 * Journals written by hand, record by record, in the order a turn stores
 * them: a resend, a dropped turn, a summary, a digest, a compact view and a
 * journal that lost its `step.ended` are records a short scripted turn does
 * not write. The sdk's journey holds the report against real turns.
 */

const session = ConversationId.make("00000000-0000-4000-8000-00000000c0de")
const run = RunOrdinal.make(0)
/** Each turn has its own run id, as a session requires. */
const runOf = (turn: number) => RunId.make(`run-${turn}`)
const id = (turn: number, n: number): EntryId => entryId(runOf(turn), n)

/** A journal as a store returns it: the drafts in order, numbered from 1, each part stored once. */
const journal = (drafts: ReadonlyArray<SessionDraft>): ReadonlyArray<SessionLogEvent> => {
  const hashes = new Set<unknown>()
  const once = drafts.filter((draft) => draft.kind !== "request.part" || (!hashes.has(draft.data["hash"]) && hashes.add(draft.data["hash"]) !== undefined))
  return once.map((draft, index) => ({ session, seq: index + 1, turn: draft.turn, kind: draft.kind, at: 0, data: draft.data }))
}

const record = (kind: string, turn: number, data: JsonObject): SessionDraft => ({ kind, turn: Option.some(turn), data })

/** The user's message that opens `turn`: its `turn.started`, which is also memory's first entry of the turn. */
const started = (turn: number, text: string): SessionDraft => Effect.runSync(turnStartedDraft(turn, {
  runId: runOf(turn), key: `key-${turn}`, origin: "user", userMessage: new UserMessage({ text }), command: {}, claimed: [], entry: id(turn, 0), at: 0,
}))

/** Memory entry `n` of `turn`, as memory stores it. */
const memory = (turn: number, n: number, step: number, body: LogBody): ReadonlyArray<SessionDraft> =>
  Option.toArray(Effect.runSync(draftOfEntry({ id: id(turn, n), runId: runOf(turn), turn, step, at: 0, body })))

const calls = (turn: number, n: number, step: number, names: ReadonlyArray<readonly [call: string, tool: string]>) => memory(turn, n, step, {
  _tag: "Message", run, message: { role: "assistant", content: names.map(([call, tool]) => ({ type: "tool-call" as const, toolCallId: ToolCallId.make(call), toolName: tool, input: {} })) },
})
/** A result as it is first written: its view is the canonical JSON of what the tool returned. */
const result = (turn: number, n: number, step: number, call: string, tool: string, view: string) => memory(turn, n, step, {
  _tag: "ToolResult", toolCallId: ToolCallId.make(call), run, toolName: tool, isError: false, encoded: view, view, viewVersion: "raw", subjects: [], artifacts: [], pinned: false,
})
/** The tool's own view of a result, recorded after it. */
const presented = (turn: number, n: number, step: number, of: EntryId, view: string) => memory(turn, n, step, {
  _tag: "ToolPresentation", entry: of, view, viewVersion: "1", subjects: [], artifacts: [], pinned: false, media: [], mediaNotes: [],
})
const compaction = (turn: number, n: number, step: number, action: Extract<LogBody, { readonly _tag: "Compaction" }>["action"]) =>
  memory(turn, n, step, { _tag: "Compaction", strategy: "window", version: "3", action })
const stepContext = (turn: number, n: number, step: number, text: string) => memory(turn, n, step, { _tag: "StepContext", step, run, text })

const SYSTEM = "Answer from the reports."
const tool = (name: string, description: string, properties: Readonly<Record<string, unknown>>): ModelRequestTool =>
  ({ name, description, parameters: { type: "object", properties, additionalProperties: false }, provider: Option.none() })
const FETCH = tool("fetch", "Fetch a report by name.", { name: { type: "string" } })
const SEARCH = tool("search", "Search every report.", { query: { type: "string" }, limit: { type: "number" } })

const headerOf = (turn: number, step: number, through: EntryId, over: Partial<ModelRequestHeader> = {}): ModelRequestHeader => ({
  version: 1, runId: runOf(turn), run, step, strategyVersion: "3", system: SYSTEM,
  render: {
    strategy: "window", currentTurn: turn, currentRun: runOf(turn), run, turnContext: "current", replies: true,
    stepContext: "tail", digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 },
  },
  through: Option.some(through), contextFingerprint: "not-compared", tools: [FETCH, SEARCH], toolChoice: "auto",
  model: Option.none(), cacheKey: Option.none(), callPolicy: Option.none(), ...over,
})

/** A request as the turn stores it: the parts its header names, then the header that names them by hash. */
const prepared = (turn: number, header: ModelRequestHeader): ReadonlyArray<SessionDraft> => {
  const stored = Effect.runSync(prepareRequestParts(header))
  return [...stored.parts.map((part) => record("request.part", turn, Effect.runSync(storedJson(part)))), record("request.prepared", turn, Effect.runSync(storedJson(stored.header)))]
}

const built = (turn: number, step: number, measured: { readonly estimatedTokens: number; readonly reservedTokens: number; readonly budgetTokens: number; readonly compactions: number }) =>
  record("context.built", turn, { step, turn, run, strategy: "window", strategyVersion: "3", fingerprint: "f", systemFingerprint: "s", activeTools: ["fetch", "search"], ...measured })
const stepStarted = (turn: number, step: number, planned = false) => record("step.started", turn, { step, run, planned, activeTools: ["fetch", "search"] })
const stepEnded = (turn: number, step: number, results: ReadonlyArray<EntryId>) =>
  record("step.ended", turn, { step, run, status: "completed", results: results.map((entry) => ({ entry, toolCallId: "c", tool: "fetch", ok: true })) })
const usage = tokenUsage({ inputTokens: 120, outputTokens: 8 })
const stepUsage = (turn: number, step: number) => record("step.usage", turn, { step, run, model: null, usage, finishReason: "stop" })
const called = (turn: number, step: number, over: Partial<ModelCallData>) => record("model.called", turn, Effect.runSync(Schema.encodeEffect(ModelCallData)({
  callId: ModelCallId.make(`call-${step}`), attempt: 1, purpose: "Loop", method: "Text", model: Option.none(), runId: Option.some(runOf(turn)),
  run: Option.some(run), step: Option.some(step), durationMs: 1, usage: { _tag: "Unknown" }, outcome: { _tag: "Completed" }, ...over,
})))

const report = (drafts: ReadonlyArray<SessionDraft>, options?: { readonly largest?: number }) => Effect.runPromise(contextReportOf(journal(drafts), options))
const tokens = (text: string) => Math.ceil(text.length / 3)

test("a step's parts reconcile with its reserve", async () => {
  // What the turn reserves: the system text, then each tool's description and canonical parameters, each estimated on its own.
  const declarations = [FETCH, SEARCH].map((declared) => `${declared.description}${canonicalJson(declared.parameters)}`)
  const reserved = tokens(SYSTEM) + declarations.reduce((sum, text) => sum + tokens(text), 0)
  const { rows } = await report([
    started(1, "compare the reports"), stepStarted(1, 0),
    built(1, 0, { estimatedTokens: 40, reservedTokens: reserved, budgetTokens: 64_000, compactions: 0 }),
    ...prepared(1, headerOf(1, 0, id(1, 0))),
  ])
  expect(rows).toHaveLength(1)
  const [row] = rows
  expect(row?.system).toEqual({ characters: 24, tokens: 8 })
  expect(row?.tools).toEqual({
    count: 2, characters: 242, tokens: 82,
    largest: [{ name: "search", characters: 133, tokens: 45 }, { name: "fetch", characters: 109, tokens: 37 }],
  })
  // The parts sum to the reserve tool by tool: the tokens of the declarations' joined text would be one fewer.
  expect((row?.system.tokens ?? 0) + (row?.tools.tokens ?? 0)).toBe(reserved)
  expect([reserved, tokens(declarations.join(""))]).toEqual([90, 81])
  expect(row?.built).toEqual(Option.some({ estimatedTokens: 40, reservedTokens: 90, budgetTokens: 64_000, compactions: 0 }))
})

test("the largest declarations are listed, as many as asked for", async () => {
  const drafts = [started(1, "compare the reports"), ...prepared(1, headerOf(1, 0, id(1, 0)))]
  expect((await report(drafts, { largest: 1 })).rows[0]?.tools.largest).toEqual([{ name: "search", characters: 133, tokens: 45 }])
  expect((await report(drafts, { largest: 0 })).rows[0]?.tools).toEqual({ count: 2, characters: 242, tokens: 82, largest: [] })
})

/*
 * One turn returns five results in its first step, and a later turn compacts
 * one of them:
 *   a  bounded as it is written (its preview is recorded before the step ends);
 *   b  spilled at the next step's start, before any request showed it;
 *   c  shown whole by one request, then spilled under pressure;
 *   d  given its tool's view and a digest;
 *   e  given its tool's view, and its compact view at the next turn's start.
 */
const a = "A".repeat(900), b = "B".repeat(800), c = "C".repeat(700), d = "D".repeat(600)
const hits = "search hits ".repeat(40), page = "E".repeat(400)
const aBound = `${"A".repeat(100)}\n[… 800 more characters kept out of context]`
const bSpill = `${"B".repeat(50)}\n[… 750 more characters kept out of context]`
const cSpill = `${"C".repeat(60)}\n[… 640 more characters kept out of context]`
const shownTurns = (ended: boolean): ReadonlyArray<SessionDraft> => [
  started(1, "compare the reports"), stepStarted(1, 0),
  built(1, 0, { estimatedTokens: 10, reservedTokens: 70, budgetTokens: 2_000, compactions: 0 }),
  ...prepared(1, headerOf(1, 0, id(1, 0))),
  ...calls(1, 1, 0, [["a", "fetch"], ["b", "fetch"], ["c", "fetch"], ["d", "search"], ["e", "read"]]),
  ...result(1, 2, 0, "a", "fetch", a),
  ...compaction(1, 3, 0, { _tag: "Spill", entry: id(1, 2), preview: aBound }),
  ...result(1, 4, 0, "b", "fetch", b),
  ...result(1, 5, 0, "c", "fetch", c),
  ...result(1, 6, 0, "d", "search", d),
  ...presented(1, 7, 0, id(1, 6), hits),
  ...memory(1, 8, 0, { _tag: "ToolDigest", entry: id(1, 6), version: "1", mode: "summarize", keep: [], text: "three hits, all in the north report", digester: "test@1", trigger: "write" }),
  ...result(1, 9, 0, "e", "read", "raw page"),
  ...presented(1, 10, 0, id(1, 9), page),
  ...(ended ? [stepEnded(1, 0, [id(1, 2), id(1, 4), id(1, 5), id(1, 6), id(1, 9)])] : []),
  stepStarted(1, 1),
  ...compaction(1, 11, 0, { _tag: "Spill", entry: id(1, 4), preview: bSpill }),
  built(1, 1, { estimatedTokens: 600, reservedTokens: 70, budgetTokens: 2_000, compactions: 2 }),
  ...prepared(1, headerOf(1, 1, id(1, 11))),
  ...memory(1, 12, 1, { _tag: "Message", run, message: { role: "assistant", content: [{ type: "text", text: "reading on" }] } }),
  ...(ended ? [stepEnded(1, 1, [])] : []),
  stepStarted(1, 2),
  ...compaction(1, 13, 0, { _tag: "Spill", entry: id(1, 5), preview: cSpill }),
  built(1, 2, { estimatedTokens: 400, reservedTokens: 70, budgetTokens: 2_000, compactions: 3 }),
  ...prepared(1, headerOf(1, 2, id(1, 13))),
  ...memory(1, 14, 2, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("compared") }),
  started(2, "and the east report?"),
  ...compaction(2, 1, 0, { _tag: "CompactViews", entries: [id(1, 9)], texts: ["page 1 of the east report"] }),
  stepStarted(2, 0),
  built(2, 0, { estimatedTokens: 300, reservedTokens: 70, budgetTokens: 2_000, compactions: 4 }),
  ...prepared(2, headerOf(2, 0, id(2, 1))),
]
/** A turn's results as a table reads them: the tool's call, its characters, how and from what it was shown, and by which step's request. */
const shownIn = (turn: ContextReport["turns"][number] | undefined) => (turn?.results ?? []).map((item) =>
  [String(item.entry), item.tool, item.characters, item.shown, item.view, item.step] as const)

describe("the tool results a turn's requests showed", () => {
  test("a result is whole, compact, digest, bounded or spilled by what its request showed", async () => {
    // Each result is listed once per turn, at the largest size a request of the turn showed it.
    const { rows, turns } = await report(shownTurns(true))
    // The first request precedes every result; the second shows all five; the third shows c through its preview.
    expect(rows.map((row) => [row.turn, row.step, row.results])).toEqual([
      [1, 0, { count: 0, characters: 0 }],
      [1, 1, { count: 5, characters: aBound.length + bSpill.length + c.length + 35 + page.length }],
      [1, 2, { count: 5, characters: aBound.length + bSpill.length + cSpill.length + 35 + page.length }],
      [2, 0, { count: 5, characters: aBound.length + bSpill.length + cSpill.length + 35 + 25 }],
    ])
    expect(shownIn(turns[0])).toEqual([
      ["run-1:5", "fetch", 700, "whole", "raw", 1],
      ["run-1:9", "read", 400, "whole", "tool", 1],
      ["run-1:2", "fetch", aBound.length, "bounded", "raw", 1],
      ["run-1:4", "fetch", bSpill.length, "spilled", "raw", 1],
      ["run-1:6", "search", 35, "digest", "tool", 1],
    ])
    // The next turn's request shows the same results: c through the preview a request of the first turn already showed, e compact.
    expect(shownIn(turns[1])).toEqual([
      ["run-1:2", "fetch", aBound.length, "bounded", "raw", 0],
      ["run-1:5", "fetch", cSpill.length, "spilled", "raw", 0],
      ["run-1:4", "fetch", bSpill.length, "spilled", "raw", 0],
      ["run-1:6", "search", 35, "digest", "tool", 0],
      ["run-1:9", "read", 25, "compact", "tool", 0],
    ])
  })

  test("a turn counts its bounds separately from its spills, and its steps separately from its requests", async () => {
    const { turns } = await report(shownTurns(true))
    expect(turns.map(({ results: _results, ...counted }) => counted)).toEqual([
      { session, turn: 1, steps: 3, requests: 3, bounds: 1, spills: 2, drops: 0, summaries: 0, digests: 1 },
      { session, turn: 2, steps: 1, requests: 1, bounds: 0, spills: 0, drops: 0, summaries: 0, digests: 0 },
    ])
  })

  test("only as many results as asked for are listed, the largest first", async () => {
    const { turns } = await report(shownTurns(true), { largest: 2 })
    expect(shownIn(turns[0]).map(([entry]) => entry)).toEqual(["run-1:5", "run-1:9"])
  })

  test("without the step's end, a preview recorded before the result's first request counts as bounded", async () => {
    const { turns } = await report(shownTurns(false))
    // b's preview was recorded before the first request that included b; c's after a request had shown c whole.
    expect(shownIn(turns[0]).map(([entry, , , shown]) => [entry, shown])).toEqual([
      ["run-1:5", "whole"], ["run-1:9", "whole"], ["run-1:2", "bounded"], ["run-1:4", "bounded"], ["run-1:6", "digest"],
    ])
    expect(shownIn(turns[1]).map(([entry, , , shown]) => [entry, shown])).toEqual([
      ["run-1:2", "bounded"], ["run-1:5", "spilled"], ["run-1:4", "bounded"], ["run-1:6", "digest"], ["run-1:9", "compact"],
    ])
    expect(turns.map((turn) => [turn.bounds, turn.spills])).toEqual([[2, 1], [0, 0]])
  })

  test("dropped turns and a summary are counted in the turn that recorded them, an image omission in none", async () => {
    const { turns } = await report([
      started(1, "first"), ...memory(1, 1, 0, { _tag: "TurnEnded", outcome: "completed", reply: Option.some("one") }),
      started(2, "second"),
      ...compaction(2, 1, 0, { _tag: "DropTurns", throughTurn: 1, ledger: "Earlier in this conversation:\n- Asked: first" }),
      ...compaction(2, 2, 0, { _tag: "Summarize", keepFromTurn: 2, summary: "The user asked first." }),
      ...compaction(2, 3, 0, { _tag: "OmitMedia", entries: [id(1, 0)], reason: "too large" }),
      stepStarted(2, 0), ...prepared(2, headerOf(2, 0, id(2, 3))),
    ])
    expect(turns.map(({ results: _results, session: _session, ...counted }) => counted)).toEqual([
      { turn: 1, steps: 0, requests: 0, bounds: 0, spills: 0, drops: 0, summaries: 0, digests: 0 },
      { turn: 2, steps: 1, requests: 1, bounds: 0, spills: 0, drops: 1, summaries: 1, digests: 0 },
    ])
  })
})

describe("a request prepared again in its step", () => {
  const overflow = (loopCalls: boolean): ReadonlyArray<SessionDraft> => [
    started(1, "compare the reports"), stepStarted(1, 0),
    built(1, 0, { estimatedTokens: 900, reservedTokens: 70, budgetTokens: 1_000, compactions: 0 }),
    ...prepared(1, headerOf(1, 0, id(1, 0))),
    // The provider refuses the request for its size; a digest helper of the same step reports a usage of its own.
    ...(loopCalls ? [called(1, 0, { outcome: { _tag: "Failed", failure: Option.some("ContextOverflow") } })] : []),
    called(1, 0, { callId: ModelCallId.make("digest"), purpose: "Helper", usage: { _tag: "Known", usage: tokenUsage({ inputTokens: 5, outputTokens: 1 }) } }),
    ...compaction(1, 1, 0, { _tag: "DropTurns", throughTurn: 0, ledger: "" }),
    built(1, 0, { estimatedTokens: 300, reservedTokens: 70, budgetTokens: 800, compactions: 1 }),
    ...prepared(1, headerOf(1, 0, id(1, 1))),
    ...(loopCalls ? [called(1, 0, { callId: ModelCallId.make("resent"), usage: { _tag: "Known", usage } })] : []),
    stepUsage(1, 0), stepEnded(1, 0, []),
  ]
  const measured = (rows: ContextReport["rows"]) => rows.map((row) => ({
    step: row.step, resend: row.resend, estimatedTokens: Option.map(row.built, (item) => item.estimatedTokens), budgetTokens: Option.map(row.built, (item) => item.budgetTokens), usage: row.usage,
  }))

  test("a resend is its own row and only the dispatched one carries usage", async () => {
    // Each request keeps its own context.built, and the call that completed for the second one tells the usage.
    const { rows, turns } = await report(overflow(true))
    expect(measured(rows)).toEqual([
      { step: 0, resend: 0, estimatedTokens: Option.some(900), budgetTokens: Option.some(1_000), usage: Option.none() },
      { step: 0, resend: 1, estimatedTokens: Option.some(300), budgetTokens: Option.some(800), usage: Option.some({ source: "model.called", usage }) },
    ])
    // Each row names its own request.prepared: the second one's parts are those the first one stored.
    expect(rows.map((row) => row.seq)).toEqual([7, 12])
    // One step, two requests.
    expect([turns[0]?.steps, turns[0]?.requests]).toEqual([1, 2])
  })

  test("with no call recorded, the accepted response's usage stands in, on the request it answered", async () => {
    const { rows } = await report(overflow(false))
    expect(rows.map((row) => row.usage)).toEqual([Option.none(), Option.some({ source: "step.usage", usage })])
  })

  test("a request that got no response carries none", async () => {
    const { rows } = await report([started(1, "compare the reports"), stepStarted(1, 0), ...prepared(1, headerOf(1, 0, id(1, 0)))])
    expect(rows.map((row) => row.usage)).toEqual([Option.none()])
    expect(rows.map((row) => row.built)).toEqual([Option.none()])
  })
})

describe("the host's context: a request hook's note and the step policy's step context", () => {
  const note = "the user is on the free plan"
  const policy = "Step 1 of 3: gather the figures."
  const context = (rows: ContextReport["rows"]) => rows.map((row) => ({ step: row.step, hookNote: row.hookNote, stepContext: row.stepContext, placement: row.contextPlacement }))

  test("a row with no hook note and no step context reports none for each, not 0", async () => {
    const found = await report([started(1, "compare the reports"), stepStarted(1, 0), ...prepared(1, headerOf(1, 0, id(1, 0)))])
    expect(context(found.rows)).toEqual([{ step: 0, hookNote: Option.none(), stepContext: Option.none(), placement: "tail" }])
    // As JSON the two are null: a reader cannot take an absent context for an empty one.
    const encoded = await Effect.runPromise(Schema.encodeEffect(ContextReport)(found))
    expect([encoded.rows[0]?.hookNote, encoded.rows[0]?.stepContext, encoded.rows[0]?.usage, encoded.rows[0]?.built]).toEqual([null, null, null, null])
  })

  test("an empty step context is 0, not none", async () => {
    const { rows } = await report([started(1, "go"), ...stepContext(1, 1, 0, ""), ...prepared(1, headerOf(1, 0, id(1, 1)))])
    expect(context(rows)).toEqual([{ step: 0, hookNote: Option.none(), stepContext: Option.some(0), placement: "tail" }])
  })

  test("the note and the step context each have their own count, the blank line between them in neither", async () => {
    const { rows } = await report([
      started(1, "go"),
      // Step 0: the policy's context and the hook's note, joined as the turn records them.
      ...stepContext(1, 1, 0, `${policy}\n\n${hostNote(note)}`),
      ...prepared(1, headerOf(1, 0, id(1, 1), { hook: { context: note } })),
      // Step 1: the hook's note alone.
      ...stepContext(1, 2, 1, hostNote(note)),
      ...prepared(1, headerOf(1, 1, id(1, 2), { hook: { context: note } })),
      // Step 2: the policy's context alone; the hook ran and added nothing.
      ...stepContext(1, 3, 2, policy),
      ...prepared(1, headerOf(1, 2, id(1, 3), { hook: {} })),
    ])
    expect(hostNote(note)).toHaveLength(41)
    expect(context(rows)).toEqual([
      { step: 0, hookNote: Option.some(41), stepContext: Option.some(32), placement: "tail" },
      { step: 1, hookNote: Option.some(41), stepContext: Option.none(), placement: "tail" },
      { step: 2, hookNote: Option.none(), stepContext: Option.some(32), placement: "tail" },
    ])
  })

  test("a step that records no context still shows its run's latest one, as its request did", async () => {
    const { rows } = await report([
      started(1, "go"),
      ...stepContext(1, 1, 0, `${policy}\n\n${hostNote(note)}`),
      ...prepared(1, headerOf(1, 0, id(1, 1), { hook: { context: note } })),
      // Step 1 records none: its request closes with step 0's, whose note the earlier header tells apart.
      ...memory(1, 2, 0, { _tag: "Message", run, message: { role: "assistant", content: [{ type: "text", text: "reading on" }] } }),
      ...prepared(1, headerOf(1, 1, id(1, 2))),
    ])
    expect(context(rows)).toEqual([
      { step: 0, hookNote: Option.some(41), stepContext: Option.some(32), placement: "tail" },
      { step: 1, hookNote: Option.some(41), stepContext: Option.some(32), placement: "tail" },
    ])
  })

  test("placed in the system text, a request holds its own step's context only, inside the system characters", async () => {
    const inSystem = (step: number, through: EntryId, system: string) => {
      const header = headerOf(1, step, through, { system })
      return prepared(1, { ...header, render: { ...header.render, stepContext: "none" } })
    }
    const { rows } = await report([
      started(1, "go"),
      ...stepContext(1, 1, 0, policy), ...inSystem(0, id(1, 1), `${SYSTEM}\n\n${policy}`),
      ...memory(1, 2, 0, { _tag: "Message", run, message: { role: "assistant", content: [{ type: "text", text: "reading on" }] } }),
      ...inSystem(1, id(1, 2), SYSTEM),
    ])
    expect(context(rows)).toEqual([
      { step: 0, hookNote: Option.none(), stepContext: Option.some(32), placement: "system" },
      { step: 1, hookNote: Option.none(), stepContext: Option.none(), placement: "system" },
    ])
    expect(rows.map((row) => row.system.characters)).toEqual([SYSTEM.length + 2 + 32, SYSTEM.length])
  })
})

test("a planned step is a step and no request", async () => {
  const { rows, turns } = await report([
    started(1, "compare the reports"),
    // Step 0 is the host's planned batch: its tools run with no provider call.
    stepStarted(1, 0, true), ...calls(1, 1, 0, [["p", "fetch"]]), ...result(1, 2, 0, "p", "fetch", "planned"), stepEnded(1, 0, [id(1, 2)]),
    stepStarted(1, 1), ...prepared(1, headerOf(1, 1, id(1, 2))), stepUsage(1, 1), stepEnded(1, 1, []),
  ])
  expect(rows.map((row) => [row.step, row.resend, row.results.count])).toEqual([[1, 0, 1]])
  expect([turns[0]?.steps, turns[0]?.requests]).toEqual([2, 1])
})

describe("a journal the report cannot read fails it", () => {
  const code = (drafts: ReadonlyArray<SessionLogEvent>) => Effect.runPromise(contextReportOf(drafts).pipe(
    Effect.match({ onSuccess: () => "read", onFailure: (error) => Option.getOrElse(harnessCodeOf(error), () => error._tag) }),
  ))

  test("a header whose parts are not among the events", async () => {
    const events = journal([started(1, "go"), ...prepared(1, headerOf(1, 0, id(1, 0)))])
    expect(await code(events.filter((event) => event.kind !== "request.part"))).toBe("request.diverged")
  })

  test("a header built through a memory entry the events lack", async () => {
    expect(await code(journal([started(1, "go"), ...prepared(1, headerOf(1, 0, id(1, 7)))]))).toBe("request.diverged")
  })

  test("a record that does not decode", async () => {
    const events = journal([started(1, "go"), ...prepared(1, headerOf(1, 0, id(1, 0))), record("step.usage", 1, { step: "first" })])
    expect(await code(events)).toBe("SchemaError")
  })
})
