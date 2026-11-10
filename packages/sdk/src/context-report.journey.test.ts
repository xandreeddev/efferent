import { expect, test } from "bun:test"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import {
  contextReportOf, ConversationId, CurrentAgentRun, CurrentAgentStep, defineCapability, defineSkill, defineTool, Failure, ModelCallId, ModelRequestHook,
  recordCompletion, RunId, SessionLogMemoryLive, Sessions, tokenUsage, TurnAdmissionOpen, UserMessage,
} from "@xandreed/core"
import type { ContextReportRow, ContextReportTurn, Turn, TurnError, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig } from "./agent.adapter.js"

/*
 * Two turns through `Agent.turn` with a scripted model, then the report of
 * the session's journal held against what the model was sent, request by
 * request: the system text, the tools, each tool result and the host
 * context that closed the messages.
 *
 * The first turn fetches a report far above the bound (shown bounded from
 * its first request), then looks a record up with a tool that has a view and
 * counts with one that has none. Its step policy gives a step context at
 * step 0 only and a request hook adds a note at step 1 only, and its model
 * records each call (`model.called`). The second turn's model records none,
 * as a host's own model port may not, and has no host context at all.
 *
 * A second session runs with the bound off and a budget the report does not
 * fit: memory spills it under pressure at the next step's start, before any
 * request has shown it. The report tells that spill from a bound.
 *
 * A third session keeps its provider's cached prefix (`compactPreviousTurn:
 * false`) and reads records with a tool that has a compact view, under a
 * budget its second turn passes at its second step: an earlier turn's
 * result, which that turn's first request showed whole, takes its compact
 * view. Its third turn is over the budget before its first request. The
 * report counts each compact view in the turn that recorded it.
 */

const FetchReport = Tool.make("fetch_report", {
  description: "Fetch a report by its name.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const Lookup = Tool.make("lookup", {
  description: "Look a record up by a word in it.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  failure: Failure,
  failureMode: "return",
})
const CountReports = Tool.make("count_reports", {
  description: "Count the reports on file.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ count: Schema.Int }),
  failure: Failure,
  failureMode: "return",
})

/** A report of 1,600 numbered lines, about 69,000 characters: more than four times the default bound. */
const report = (name: string): string =>
  Array.from({ length: 1_600 }, (_, index) => `${name} line ${String(index + 1).padStart(4, "0")}: figures filed under ${name}`).join("\n")

const host = defineCapability({
  id: "context-report-host", version: "1",
  tools: [
    // No view: the model is shown the returned text, bounded as it is written.
    defineTool({ tool: FetchReport, handler: ({ name }) => Effect.succeed(report(name)), annotations: { readOnly: true } }),
    defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed({ ids: [`record-${query}-a`, `record-${query}-b`] }), view: { version: "1", render: (result) => `FOUND ${result.ids.join(", ")}` } }),
    // No view, and short: the model is shown its canonical JSON whole.
    defineTool({ tool: CountReports, handler: () => Effect.succeed({ count: 4 }), annotations: { readOnly: true } }),
  ],
  skills: [defineSkill({ id: "core", summary: "Read the reports.", tools: ["fetch_report", "lookup", "count_reports"], always: true })],
})

const ReadRecords = Tool.make("read_records", {
  description: "Read the records filed under a name.",
  parameters: Schema.Struct({ name: Schema.String, count: Schema.Int }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const records = (name: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `record-${name}-${String(index + 1).padStart(2, "0")}: ${name} entry ${index + 1}, filed under ${name}`).join("\n")
/** What the records show through their compact view. */
const compactRecords = (name: string, count: number): string => `${count} ${name} records, record-${name}-01 to record-${name}-${String(count).padStart(2, "0")}`

const archive = defineCapability({
  id: "context-report-archive", version: "1",
  tools: [defineTool({
    tool: ReadRecords, handler: ({ name, count }) => Effect.succeed(records(name, count)), annotations: { readOnly: true },
    view: { version: "1", render: (result) => result, compact: (_result, { name, count }) => compactRecords(name, count) },
  })],
  skills: [defineSkill({ id: "core", summary: "Read the records.", tools: ["read_records"], always: true })],
})

const SYSTEM = "Answer from the reports."
const POLICY = "Step 1: fetch the report before anything else."
const NOTE = "the reader holds the north region only"
const BOUND = 16_000
/** What the lookup's view and the count's canonical JSON show. */
const FOUND = "FOUND record-north-a, record-north-b"
const COUNTED = '{"count":4}'
const BUDGET = 64_000

type Part = ReadonlyArray<unknown>
/** What the provider reports for a response; the scripted model's own call record reports one token more of input. */
const finish = (reason: string) => ({ type: "finish", reason, usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } } })
const call = (...calls: ReadonlyArray<readonly [id: string, name: string, params: unknown]>): Part =>
  [...calls.map(([id, name, params]) => ({ type: "tool-call", id, name, params })), finish("tool-calls")]
const stop = (text: string): Part => [{ type: "text", text }, finish("stop")]
const encodePrompt = Schema.encodeSync(Prompt.Prompt)

/** A model request as the journey reads it: the system text, the tools offered, each tool result's text and the last user-role message. */
interface Seen {
  readonly system: string
  readonly tools: ReadonlyArray<string>
  readonly results: ReadonlyArray<{ readonly name: string; readonly text: string }>
  readonly last: string
}

/** A settled model that answers from `script` and records each request; with `recording`, it records its own call as the models plugin does. */
const scripted = (seen: Ref.Ref<ReadonlyArray<Seen>>, script: ReadonlyArray<Part>, recording: boolean) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      const prompt = encodePrompt(options.prompt)
      yield* Ref.update(seen, (all) => [...all, {
        system: prompt.content.flatMap((message) => message.role === "system" ? [message.content] : []).join("\n"),
        tools: options.tools.map((tool) => tool.name),
        results: prompt.content.flatMap((message) => message.role === "tool" ? message.content.flatMap((part) => part.type === "tool-result" ? [{ name: part.name, text: String(part.result) }] : []) : []),
        last: prompt.content.flatMap((message) => message.role === "user" ? [typeof message.content === "string" ? message.content : message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")] : []).at(-1) ?? "",
      }])
      if (recording) {
        const run = yield* CurrentAgentRun
        yield* recordCompletion({
          callId: ModelCallId.make(`loop-${index}`), attempt: 1, purpose: "Loop", method: "Text", model: Option.none(),
          runId: Option.map(run, (value) => value.id), run: Option.map(run, (value) => value.ordinal), step: yield* CurrentAgentStep, durationMs: 1,
          usage: { _tag: "Known", usage: tokenUsage({ inputTokens: 101, outputTokens: 10 }) }, outcome: { _tag: "Completed" },
        }).pipe(Effect.orDie)
      }
      return (script[index] ?? stop("done")) as never
    }),
    streamText: () => Stream.die("not scripted"),
  })
})

const outcomeOf = (result: { readonly outcome: TurnOutcome["outcome"]; readonly text: string }): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })

/** A fresh session and an agent over `memory` with `budgetTokens` and the tools of `capability`: its scripted turns, what the model was sent and the stored journal. */
const sessionOf = (conversation: string, memory: AgentConfig["plugins"][number], budgetTokens: number, capability = host) => Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: ConversationId.make(conversation), owner: "context-report-journey" }
  yield* sessions.create({ owner: address.owner, id: address.id })
  const agent = yield* Agent.define({
    plugins: [memory, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [capability],
    turnServices: [LanguageModel.LanguageModel, Sessions],
    limits: { streaming: false, maxSteps: 6 },
    system: SYSTEM,
    budgetTokens,
  })
  const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
  const turn = (runId: string, text: string, script: ReadonlyArray<Part>, recording: boolean, use: (turn: Turn) => Effect.Effect<TurnOutcome, TurnError>) => Effect.gen(function* () {
    const model = yield* scripted(seen, script, recording)
    return yield* agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text }), runId: RunId.make(runId) },
      services: Context.make(LanguageModel.LanguageModel, model).pipe(
        Context.add(Sessions, sessions),
        // The host's hook: a note at the first turn's second step, nothing anywhere else.
        Context.add(ModelRequestHook, { prepare: (draft) => Effect.succeed(draft.run.turn === 1 && draft.step === 1 ? { context: NOTE } : {}) }),
      ),
    }, use)
  })
  return { turn, seen: Ref.get(seen), events: sessions.read(address) }
})

const journey = Effect.scoped(Effect.gen(function* () {
  const session = yield* sessionOf("00000000-0000-4000-8000-0000c0a7e9a1", memoryWindowPlugin, BUDGET)
  const { turn } = session
  const first = yield* turn("run-1", "compare the north report with the records", [
    call(["f1", "fetch_report", { name: "north" }]),
    call(["l1", "lookup", { query: "north" }], ["c1", "count_reports", {}]),
    stop("The north report matches two of four records."),
  ], true, (running) => running.tools.select(running.userMessage).pipe(
    Effect.andThen(running.run({
      // The step policy's step context: at step 0 only.
      step: (info) => Effect.succeed({ context: info.stepIndex === 0 ? Option.some(POLICY) : Option.none(), toolChoice: Option.none() }),
      limits: { requireCompletion: false },
    })),
    Effect.map(outcomeOf),
  ))
  const second = yield* turn("run-2", "thanks, that is all", [stop("You are welcome.")], false, (running) => running.tools.select(running.userMessage).pipe(
    Effect.andThen(running.run({ limits: { requireCompletion: false } })),
    Effect.map(outcomeOf),
  ))
  const events = yield* session.events
  return { outcomes: [first.outcome, second.outcome], seen: yield* session.seen, events, report: yield* contextReportOf(events) }
}))

/** The bound is off and the budget is about a third of the report's estimate: the turn fits only once memory spills the report under pressure. */
const TIGHT = 8_000
const PREVIEW = 600
const pressed = Effect.scoped(Effect.gen(function* () {
  const session = yield* sessionOf("00000000-0000-4000-8000-0000c0a7e9a2", { plugin: memoryWindowPlugin, options: { boundOnWriteChars: 0 } }, TIGHT)
  const result = yield* session.turn("run-1", "read the north report", [call(["f1", "fetch_report", { name: "north" }]), stop("Read.")], false,
    (running) => running.tools.select(running.userMessage).pipe(Effect.andThen(running.run({ limits: { requireCompletion: false } })), Effect.map(outcomeOf)))
  const events = yield* session.events
  return { outcome: result.outcome, seen: yield* session.seen, events, report: yield* contextReportOf(events) }
}))

const ALPHA = { name: "alpha", count: 10 }
const BETA = { name: "beta", count: 60 }
/** The third turn's question takes more of the budget than the alpha records' compact view freed, so the turn is over it before its first request. */
const QUESTION = `Compare the two sets record by record. ${"Which records are filed twice, and under which name? ".repeat(24)}`
/** Three turns under `budgetTokens`, with no turn start rewriting an earlier turn and no bound: only the budget changes what a request shows. */
const compacted = (budgetTokens: number) => Effect.scoped(Effect.gen(function* () {
  const session = yield* sessionOf("00000000-0000-4000-8000-0000c0a7e9a3", { plugin: memoryWindowPlugin, options: { compactPreviousTurn: false, boundOnWriteChars: 0 } }, budgetTokens, archive)
  const run = (runId: string, text: string, script: ReadonlyArray<Part>) => session.turn(runId, text, script, false,
    (running) => running.tools.select(running.userMessage).pipe(Effect.andThen(running.run({ limits: { requireCompletion: false } })), Effect.map(outcomeOf)))
  const first = yield* run("run-1", "read the alpha records", [call(["a1", "read_records", ALPHA]), stop("Alpha has ten records.")])
  const second = yield* run("run-2", "and the beta records?", [call(["b1", "read_records", BETA]), stop("Beta has sixty records.")])
  const third = yield* run("run-3", QUESTION, [stop("None is filed twice.")])
  const events = yield* session.events
  return { outcomes: [first.outcome, second.outcome, third.outcome], seen: yield* session.seen, events, report: yield* contextReportOf(events) }
}))

/** The entry id of the first `fetch_report` result the journal holds: the locator its notice names. */
const fetchedIn = (events: ReadonlyArray<{ readonly kind: string; readonly data: Readonly<Record<string, unknown>> }>) =>
  events.flatMap((event) => event.kind === "memory.tool-result" && Schema.is(Schema.Struct({ body: Schema.Struct({ toolName: Schema.Literal("fetch_report") }) }))(event.data) ? [String(event.data["entry"])] : [])[0] ?? ""
/** The notice a shortened result ends with, as core's `spillPreview` writes it after the first `shown` characters. */
const shortened = (text: string, shown: number, locator: string) =>
  `${text.slice(0, shown)}\n[… ${text.length - shown} more characters kept out of context; call recall_context with locator "${locator}" and offset ${shown} to read them]`
/** A turn's results as a table reads them. */
const shownIn = (turn: ContextReportTurn | undefined) => (turn?.results ?? []).map((result) => [result.tool, result.characters, result.shown, result.view, result.step])
/** A turn's counts, without its results. */
const countedIn = (turns: ReadonlyArray<ContextReportTurn>) => turns.map(({ results: _results, session: _session, ...counted }) => counted)

/** What a row says its request carried: the system text's characters, the tools, the tool results and their characters. */
const reported = (row: ContextReportRow) => ({ system: row.system.characters, tools: row.tools.count, results: { count: row.results.count, characters: row.results.characters } })
/** The same, counted from what the model was sent. */
const sent = (request: Seen) => ({
  system: request.system.length, tools: request.tools.length,
  results: { count: request.results.length, characters: request.results.reduce((sum, result) => sum + result.text.length, 0) },
})

test("the report of a real turn's journal matches what each request carried, one result bounded as it was written", async () => {
  const { outcomes, seen, events, report: found } = await Effect.runPromise(journey)
  expect(outcomes).toEqual(["completed", "completed"])
  expect(seen).toHaveLength(4)

  // A row per request the model was sent, in order.
  const { rows, turns } = found
  expect(rows.map((row) => [row.turn, String(row.runId), row.run, row.step, row.resend])).toEqual([[1, "run-1", 0, 0, 0], [1, "run-1", 0, 1, 0], [1, "run-1", 0, 2, 0], [2, "run-2", 0, 0, 0]])
  expect(rows.map((row) => row.seq)).toEqual(events.filter((event) => event.kind === "request.prepared").map((event) => event.seq))

  // The system text, the tool declarations and the tool results are those of the request itself.
  expect(rows.map(reported)).toEqual(seen.map(sent))
  expect(seen.map((request) => request.system)).toEqual(seen.map(() => SYSTEM))
  expect(rows.map((row) => row.system)).toEqual(rows.map(() => ({ characters: SYSTEM.length, tokens: 8 })))
  expect(seen.map((request) => [...request.tools].sort())).toEqual(seen.map(() => ["count_reports", "fetch_report", "load_skill", "lookup", "recall_context"]))
  expect(rows.map((row) => row.tools.largest.map((tool) => tool.name).toSorted())).toEqual(rows.map(() => ["count_reports", "fetch_report", "load_skill", "lookup", "recall_context"]))
  expect(rows.map((row) => row.tools.characters)).toEqual(rows.map((row) => row.tools.largest.reduce((sum, tool) => sum + tool.characters, 0)))

  // The parts reconcile with what the turn reserved for them, to the token, and the budget is the agent's.
  const measured = rows.map((row) => Option.getOrElse(row.built, () => ({ estimatedTokens: -1, reservedTokens: -1, budgetTokens: -1, compactions: -1 })))
  expect(rows.map((row) => row.system.tokens + row.tools.tokens)).toEqual(measured.map((built) => built.reservedTokens))
  expect(measured.map((built) => [built.budgetTokens, built.compactions])).toEqual([[BUDGET, 0], [BUDGET, 1], [BUDGET, 1], [BUDGET, 1]])
  expect(measured.every((built) => built.estimatedTokens > 0 && built.estimatedTokens + built.reservedTokens < BUDGET)).toBe(true)

  // The fetched report is shown bounded from the first request that includes it; the request carried exactly this text.
  const fetched = fetchedIn(events)
  const bounded = shortened(report("north"), BOUND, fetched)
  expect(seen.map((request) => request.results)).toEqual([
    [],
    [{ name: "fetch_report", text: bounded }],
    [{ name: "fetch_report", text: bounded }, { name: "lookup", text: FOUND }, { name: "count_reports", text: COUNTED }],
    [{ name: "fetch_report", text: bounded }, { name: "lookup", text: FOUND }, { name: "count_reports", text: COUNTED }],
  ])
  // Each result once per turn, largest first, with the step whose request first showed it at that size.
  expect(shownIn(turns[0])).toEqual([["fetch_report", bounded.length, "bounded", "raw", 1], ["lookup", FOUND.length, "whole", "tool", 2], ["count_reports", COUNTED.length, "whole", "raw", 2]])
  expect(shownIn(turns[1])).toEqual([["fetch_report", bounded.length, "bounded", "raw", 0], ["lookup", FOUND.length, "whole", "tool", 0], ["count_reports", COUNTED.length, "whole", "raw", 0]])
  expect(turns[0]?.results.map((result) => String(result.entry))[0]).toBe(fetched)

  // The bound is in the journal before the end of the step that returned the result: that order is what tells it from a spill.
  const kinds = events.map((event) => event.kind)
  expect(kinds.indexOf("memory.compaction")).toBeGreaterThan(kinds.indexOf("memory.tool-result"))
  expect(kinds.indexOf("memory.compaction")).toBeLessThan(kinds.indexOf("step.ended"))
  expect(countedIn(turns)).toEqual([
    { turn: 1, steps: 3, requests: 3, bounds: 1, spills: 0, compacts: 0, drops: 0, summaries: 0, digests: 0 },
    { turn: 2, steps: 1, requests: 1, bounds: 0, spills: 0, compacts: 0, drops: 0, summaries: 0, digests: 0 },
  ])

  // The host's context, as each request closed with it: the policy's at step 0, the hook's note from step 1 on (step 2
  // records none and still shows step 1's), and none of either in the second turn, where 0 would claim an empty text.
  expect(seen.map((request) => request.last)).toEqual([POLICY, `[Host note: ${NOTE}]`, `[Host note: ${NOTE}]`, "thanks, that is all"])
  expect(rows.map((row) => ({ stepContext: row.stepContext, hookNote: row.hookNote, placement: row.contextPlacement }))).toEqual([
    { stepContext: Option.some(POLICY.length), hookNote: Option.none(), placement: "tail" },
    { stepContext: Option.none(), hookNote: Option.some(`[Host note: ${NOTE}]`.length), placement: "tail" },
    { stepContext: Option.none(), hookNote: Option.some(`[Host note: ${NOTE}]`.length), placement: "tail" },
    { stepContext: Option.none(), hookNote: Option.none(), placement: "tail" },
  ])

  // Usage: the first turn's model recorded its calls; the second turn's recorded none, so its accepted response stands in.
  expect(events.filter((event) => event.kind === "model.called").map((event) => Option.getOrElse(event.turn, () => 0))).toEqual([1, 1, 1])
  expect(rows.map((row) => row.usage)).toEqual([
    ...[0, 1, 2].map(() => Option.some({ source: "model.called" as const, usage: tokenUsage({ inputTokens: 101, outputTokens: 10 }) })),
    Option.some({ source: "step.usage" as const, usage: tokenUsage({ inputTokens: 100, outputTokens: 10 }) }),
  ])
})

test("a result spilled under pressure before any request showed it is reported spilled, not bounded", async () => {
  const { outcome, seen, events, report: found } = await Effect.runPromise(pressed)
  expect(outcome).toBe("completed")
  // The report alone is about 23,000 estimated tokens, nearly three times the budget.
  expect(Math.ceil(report("north").length / 3)).toBeGreaterThan(2 * TIGHT)

  // The second request showed the report through the pressure preview; no request ever showed it whole.
  const spilled = shortened(report("north"), PREVIEW, fetchedIn(events))
  expect(seen.map((request) => request.results)).toEqual([[], [{ name: "fetch_report", text: spilled }]])
  expect(found.rows.map(reported)).toEqual(seen.map(sent))
  expect(found.rows.map((row) => [row.step, Option.map(row.built, (built) => [built.budgetTokens, built.compactions])])).toEqual([[0, Option.some([TIGHT, 0])], [1, Option.some([TIGHT, 1])]])

  // Memory recorded the preview after the step that returned the report had ended, at the next step's start, and before
  // that step's request: the first request that includes the report. Its place before that request does not make it a bound.
  const kinds = events.map((event) => event.kind)
  expect(kinds.filter((kind) => kind === "memory.compaction")).toHaveLength(1)
  expect(kinds.indexOf("memory.compaction")).toBeGreaterThan(kinds.indexOf("step.ended"))
  expect(kinds.indexOf("memory.compaction")).toBeLessThan(kinds.lastIndexOf("request.prepared"))
  expect(shownIn(found.turns[0])).toEqual([["fetch_report", spilled.length, "spilled", "raw", 1]])
  expect(countedIn(found.turns)).toEqual([{ turn: 1, steps: 2, requests: 2, bounds: 0, spills: 1, compacts: 0, drops: 0, summaries: 0, digests: 0 }])
})

test("a compact view recorded under pressure is counted in its turn, and its result listed as each request showed it", async () => {
  // Under the agent's default budget the three turns fit: no compact view is recorded, and the report counts none.
  const wide = await Effect.runPromise(compacted(BUDGET))
  expect(wide.outcomes).toEqual(["completed", "completed", "completed"])
  expect(wide.events.filter((event) => event.kind === "memory.compaction")).toEqual([])
  expect(countedIn(wide.report.turns).map((turn) => turn.compacts)).toEqual([0, 0, 0])
  const [alpha, beta] = [records(ALPHA.name, ALPHA.count), records(BETA.name, BETA.count)]
  expect(wide.seen.at(-1)?.results).toEqual([{ name: "read_records", text: alpha }, { name: "read_records", text: beta }])

  // One token under what the second turn's second request took there, that request is the first over the budget.
  const needed = wide.report.rows.flatMap((row) => row.turn === 2 && row.step === 1 ? Option.toArray(Option.map(row.built, (built) => built.estimatedTokens + built.reservedTokens)) : [])[0] ?? 0
  expect(needed).toBeGreaterThan(0)
  const { outcomes, seen, events, report: found } = await Effect.runPromise(compacted(needed - 1))
  expect(outcomes).toEqual(["completed", "completed", "completed"])
  const [compactAlpha, compactBeta] = [compactRecords(ALPHA.name, ALPHA.count), compactRecords(BETA.name, BETA.count)]

  // The second turn's first request showed the alpha records whole and its second, over the budget, compact;
  // the third turn was over the budget before its first request, which showed the beta records compact too.
  expect(seen.map((request) => request.results.map((result) => result.text))).toEqual([[], [alpha], [alpha], [compactAlpha, beta], [compactAlpha, compactBeta]])
  expect(found.rows.map(reported)).toEqual(seen.map(sent))
  expect(found.rows.map((row) => [row.turn, row.step, Option.map(row.built, (built) => built.compactions)])).toEqual([
    [1, 0, Option.some(0)], [1, 1, Option.some(0)], [2, 0, Option.some(0)], [2, 1, Option.some(1)], [3, 0, Option.some(2)],
  ])
  expect(found.rows.every((row) => Option.exists(row.built, (built) => built.estimatedTokens + built.reservedTokens <= needed - 1))).toBe(true)

  // Memory recorded one compaction in each of those turns, the third turn's before its first request.
  const kinds = events.map((event) => event.kind)
  expect(events.flatMap((event) => event.kind === "memory.compaction" ? [Option.getOrElse(event.turn, () => 0)] : [])).toEqual([2, 3])
  expect(kinds.lastIndexOf("memory.compaction")).toBeLessThan(kinds.lastIndexOf("request.prepared"))
  expect(countedIn(found.turns)).toEqual([
    { turn: 1, steps: 2, requests: 2, bounds: 0, spills: 0, compacts: 0, drops: 0, summaries: 0, digests: 0 },
    { turn: 2, steps: 2, requests: 2, bounds: 0, spills: 0, compacts: 1, drops: 0, summaries: 0, digests: 0 },
    { turn: 3, steps: 1, requests: 1, bounds: 0, spills: 0, compacts: 1, drops: 0, summaries: 0, digests: 0 },
  ])

  // A turn lists a result at the largest size one of its requests showed it. The second turn's first request showed the
  // alpha records whole, so that turn lists them whole, by that request: its count is what says they were compacted.
  expect(shownIn(found.turns[1])).toEqual([["read_records", beta.length, "whole", "tool", 1], ["read_records", alpha.length, "whole", "tool", 0]])
  // No request of the third turn showed either result larger than its compact view: both are listed compact.
  expect(shownIn(found.turns[2])).toEqual([["read_records", compactAlpha.length, "compact", "tool", 0], ["read_records", compactBeta.length, "compact", "tool", 0]])
})
