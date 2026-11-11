import { describe, expect, test } from "bun:test"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { ConversationId, defineCapability, defineSkill, defineTool, entriesOfEvents, Failure, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage, UtilityCompletion, UtilityLlm } from "@xandreed/core"
import type { Turn, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig } from "./agent.adapter.js"

/*
 * A host tool with no view returns a report of about 69,000 characters, which
 * both memory strategies show as its first 16,000 characters and a notice.
 * `recall_context` reads on from the notice's offset. A model that asks
 * instead for text the request already shows (the report's start, a page it
 * read a step ago, or an offset inside that page) gets no text again: the
 * reply says where to read on, the model follows it, and one that keeps
 * asking is stopped by the step loop's breaker long before the step limit.
 * A page never holds text of a page already read: a model that steps down
 * through the report, each call a little below the last, is served only the
 * text between, and the request never holds a character of the report twice.
 * A refusal stays in the conversation after memory shortens the result it
 * was about: followed then, it still leads to where the result's shown form
 * ends. A report of an earlier turn is served as before. Two calls
 * for one page made together in one response: the second is refused when a
 * turn runs its calls one after another, as it does by default, and both are
 * served when they run at once.
 */

const FetchReport = Tool.make("fetch_report", {
  description: "Fetch a report by its name.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

/** A report of 1,600 numbered lines, about 69,000 characters: more than four times the default bound. */
const report = (name: string): string =>
  Array.from({ length: 1_600 }, (_, index) => `${name} line ${String(index + 1).padStart(4, "0")}: figures filed under ${name}`).join("\n")

const FetchTable = Tool.make("fetch_table", {
  description: "Fetch a table by its name.",
  parameters: Schema.Struct({ name: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

/** What a table shows once the window strategy gives it its compact view. */
const compactTable = (name: string): string => `the ${name} table, 1,600 rows`

// `fetch_report` has no view: the model is shown the returned text as it is. `fetch_table` returns the same text and has a compact view.
const host = defineCapability({
  id: "recall-guard-host", version: "1",
  tools: [
    defineTool({ tool: FetchReport, handler: ({ name }) => Effect.succeed(report(name)), annotations: { readOnly: true } }),
    defineTool({
      tool: FetchTable, handler: ({ name }) => Effect.succeed(report(name)), annotations: { readOnly: true },
      view: { version: "1", render: (result) => result, compact: (_result, { name }) => compactTable(name) },
    }),
  ],
  skills: [defineSkill({ id: "core", summary: "Fetch reports and tables.", tools: ["fetch_report", "fetch_table"], always: true })],
})

const BOUND = 16_000
const RECALL_PAGE = 8_000
/** The refused calls in a row that end a run: the first, then the five repeats the loop's breaker stops at by default. */
const REFUSALS_TO_STOP = 6
/** The longest forward stride the breaker stops inside one page: that many calls must start past the page's start and before its end. */
const STOPPED_STRIDE = Math.floor((RECALL_PAGE - 1) / REFUSALS_TO_STOP)
const north = report("north")

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]
const encodePrompt = Schema.encodeSync(Prompt.Prompt)

/** A model request as the journey reads it: the tool calls it holds and its tool results, each in order. */
interface Seen {
  readonly calls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>
  readonly results: ReadonlyArray<{ readonly name: string; readonly result: unknown }>
}

/** A settled model: each step of `script` answers from the request it is given, which is recorded. */
const scripted = (seen: Ref.Ref<ReadonlyArray<Seen>>, script: ReadonlyArray<(request: Seen) => Part>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      const prompt = encodePrompt(options.prompt)
      const request: Seen = {
        calls: prompt.content.flatMap((message) => message.role === "assistant" && Array.isArray(message.content) ? message.content.flatMap((part) => part.type === "tool-call" ? [{ name: part.name, params: part.params }] : []) : []),
        results: prompt.content.flatMap((message) => message.role === "tool" ? message.content.flatMap((part) => part.type === "tool-result" ? [{ name: part.name, result: part.result }] : []) : []),
      }
      yield* Ref.update(seen, (all) => [...all, request])
      return (script[index]?.(request) ?? stop("done")) as never
    }),
    streamText: () => Stream.die("not scripted"),
  })
})

/** The offset in the notice a result ends with, when it ends with one. */
const noticedOffset = (result: unknown): Option.Option<number> => Option.map(Option.fromNullishOr(/ and offset (\d+) to read them\]$/.exec(String(result))?.[1]), Number)
const decodeRecall = Schema.decodeUnknownOption(Schema.Struct({ locator: Schema.String }))
/** The locator of the first result, the report: the one its notice gives, else the one the model's own earlier `recall_context` call passed. */
const locatorOf = (request: Seen): string => /locator "([^"]+)" and offset \d+ to read them\]$/.exec(String(request.results[0]?.result))?.[1]
  ?? Option.getOrElse(Option.map(Option.flatMap(Option.fromNullishOr(request.calls.find((made) => made.name === "recall_context")), (made) => decodeRecall(made.params)), (params) => params.locator), () => "no locator shown")
/** A returned failure as the model is shown it: the result's text, its JSON with the keys in order. */
const failureShown = (failure: Failure): string => JSON.stringify({ error: failure.error, message: failure.message })
/**
 * The offset a model that follows the last reply of `recall_context` passes
 * next: the one the reply names; else, when the reply sends it to the
 * report's shortened form, the offset in the notice the report shows in this
 * request, or 0 when it shows none.
 */
const offsetFollowed = (request: Seen): Option.Option<number> => {
  const message = Option.match(Schema.decodeUnknownOption(Schema.fromJsonString(Failure))(request.results.findLast((result) => result.name === "recall_context")?.result), { onNone: () => "", onSome: (failure) => failure.message })
  const named = Option.map(Option.fromNullishOr(/To read on, pass offset (\d+)\.$/.exec(message)?.[1]), Number)
  if (Option.isSome(named) || !message.includes("its shortened form shows now")) return named
  return Option.orElse(noticedOffset(request.results[0]?.result), () => Option.some(0))
}

/** The notice a result shortened to its first `chars` characters ends with, and a page of the report as `recall_context` returns it. */
const shortened = (locator: string, chars: number) => `${north.slice(0, chars)}\n[… ${north.length - chars} more characters kept out of context; call recall_context with locator "${locator}" and offset ${chars} to read them]`
const bounded = (locator: string) => shortened(locator, BOUND)
const page = (locator: string, from: number) => `${north.slice(from, from + RECALL_PAGE)}\n[… ${north.length - from - RECALL_PAGE} more characters; call recall_context with locator "${locator}" and offset ${from + RECALL_PAGE}]`
/** A page of the report that ends at `to`, where text already read starts and runs to `next`. */
const cutPage = (locator: string, from: number, to: number, next: number) => `${north.slice(from, to)}\n[… the next ${next - to} characters are in text you already read, shown above; ${north.length - next} more characters after them; call recall_context with locator "${locator}" and offset ${next}]`
/** The characters of a page, without the line that says how to read on. */
const pageBody = (served: string) => served.slice(0, served.lastIndexOf("\n[… "))

/** The replies of `recall_context` that return no text, as the model reads them. */
const headShown: Failure = { error: "ResultShown", message: "That offset was inside the text this result showed when you asked, so nothing was returned. To read on, pass the offset its shortened form shows now, or offset 0 if it shows none." }
const pageRead = (next: number): Failure => ({ error: "AlreadyRecalled", message: `The text from that offset is in a page you already read, shown above. To read on, pass offset ${next}.` })

const MAX_STEPS = 24

/**
 * The turns of `scripts`, in order, in one fresh session under `memory`:
 * every request the model saw in each turn, how each turn's run ended, and
 * the stored result of every `recall_context` call.
 */
const runTurns = (memory: AgentConfig["plugins"][number], scripts: ReadonlyArray<ReadonlyArray<(request: Seen) => Part>>, limits: { readonly toolConcurrency?: number } = {}, budgetTokens?: number) => Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: ConversationId.make("00000000-0000-4000-8000-00009ca11a2d"), owner: "recall-guard-journey" }
  yield* sessions.create({ owner: address.owner, id: address.id })
  // The summary strategy reads a summarizer where its session opens; nothing in these turns passes its trigger.
  const utility = UtilityLlm.of({ complete: () => Effect.succeed(new UtilityCompletion({ text: "SUMMARY", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })) })
  const agent = yield* Agent.define({
    plugins: [memory, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [host],
    turnServices: [LanguageModel.LanguageModel, UtilityLlm],
    limits: { streaming: false, maxSteps: MAX_STEPS, ...limits },
    system: "Answer from the reports.",
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
  })
  const turns = yield* Effect.forEach(scripts, (script, index) => Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
    const model = yield* scripted(seen, script)
    const reason = yield* Ref.make("not run")
    const runToStop = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
      Effect.andThen(turn.run({ limits: { requireCompletion: false } })),
      Effect.tap((result) => Ref.set(reason, result.reason)),
      Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
    )
    const outcome = yield* agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: index === 0 ? "what does the north report say?" : "and how does it end?" }), runId: RunId.make(`run-${index + 1}`) },
      services: Context.mergeAll(Context.make(LanguageModel.LanguageModel, model), Context.make(UtilityLlm, utility), Context.make(Sessions, sessions)),
    }, runToStop)
    return { outcome: outcome.outcome, reason: yield* Ref.get(reason), requests: yield* Ref.get(seen) }
  }), { concurrency: 1 })
  const stored = yield* sessions.read(address)
  const entries = yield* entriesOfEvents(stored)
  return {
    turns,
    recalls: entries.flatMap((entry) => entry.body._tag === "ToolResult" && entry.body.toolName === "recall_context" ? [{ isError: entry.body.isError, view: entry.body.view }] : []),
    /** The run each stored `recall_context` result names (none is left out): the guard counts a page as read only for the run that recorded it. */
    recallRuns: entries.flatMap((entry) => entry.body._tag === "ToolResult" && entry.body.toolName === "recall_context" && entry.body.run !== undefined ? [Number(entry.body.run)] : []),
  }
}))

const fetchNorth = () => call("f1", "fetch_report", { name: "north" })
const recall = (id: string, offset: (request: Seen) => number | undefined) => (request: Seen): Part => {
  const from = offset(request)
  return call(id, "recall_context", { locator: locatorOf(request), ...(from === undefined ? {} : { offset: from }) })
}
/** A call that follows the last reply of `recall_context`; -1, which the tool's schema refuses, when the reply gives nothing to pass. */
const followReply = (id: string) => recall(id, (request) => Option.getOrElse(offsetFollowed(request), () => -1))

const strategies = [
  { plugin: memoryWindowPlugin, strategy: "window" },
  { plugin: memorySummaryPlugin, strategy: "summary" },
] as const

strategies.map(({ plugin, strategy }) => describe(`recall_context and text the turn still shows, under the ${strategy} strategy`, () => {
  test("a model that asks for shown text is told where to read on from, and reads the next page", async () => {
    const ran = await Effect.runPromise(runTurns(plugin, [[
      fetchNorth,
      // The model asks for the report from its start, which the request shows.
      recall("r1", () => undefined),
      // It follows the reply, which sends it to the offset the report's shortened form shows: the next page.
      followReply("r2"),
      // It asks for that page again,
      recall("r3", () => BOUND),
      // and follows the reply again, which names the offset.
      followReply("r4"),
      // It asks from the middle of the first page it read,
      recall("r5", () => BOUND + 4_000),
      // and from the middle of the report's shown start.
      recall("r6", () => 8_000),
      () => stop("The north report is read."),
    ]]))
    const [turn] = ran.turns
    expect(turn?.outcome).toBe("completed")
    expect(turn?.reason).toBe("completed")
    const requests = turn?.requests ?? []
    expect(requests).toHaveLength(8)
    const locator = locatorOf(requests[1] ?? { calls: [], results: [] })
    // The last request holds the whole exchange: the report bounded, then each reply of recall_context in order.
    expect(requests.at(-1)?.results).toEqual([
      { name: "fetch_report", result: bounded(locator) },
      { name: "recall_context", result: failureShown(headShown) },
      { name: "recall_context", result: page(locator, BOUND) },
      { name: "recall_context", result: failureShown(pageRead(BOUND + RECALL_PAGE)) },
      { name: "recall_context", result: page(locator, BOUND + RECALL_PAGE) },
      { name: "recall_context", result: failureShown(pageRead(BOUND + RECALL_PAGE)) },
      { name: "recall_context", result: failureShown(headShown) },
    ])
    // Each request shows what the one before it showed, and one more reply.
    expect(requests.map((request) => request.results.length)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    // A refusal is stored as the failed call's result, as any returned failure is; a page is the tool's result.
    expect(ran.recalls).toEqual([
      { isError: true, view: failureShown(headShown) }, { isError: false, view: page(locator, BOUND) },
      { isError: true, view: failureShown(pageRead(BOUND + RECALL_PAGE)) }, { isError: false, view: page(locator, BOUND + RECALL_PAGE) },
      { isError: true, view: failureShown(pageRead(BOUND + RECALL_PAGE)) }, { isError: true, view: failureShown(headShown) },
    ])
    // Every one of them names the turn's first run: a page is refused again because the handler knows the run that asks.
    expect(ran.recallRuns).toEqual([0, 0, 0, 0, 0, 0])
  })

  test("a model that keeps asking for shown text, from a new offset each step, is stopped by the loop's breaker before the step limit", async () => {
    // Each call asks from another offset inside the 16,000 characters shown: before the guard each got another page back, and only the step limit ended the run.
    const asking = Array.from({ length: MAX_STEPS }, (_, index) => recall(`a${index + 1}`, () => (index + 1) * 100))
    const ran = await Effect.runPromise(runTurns(plugin, [[fetchNorth, ...asking]]))
    const [turn] = ran.turns
    expect(turn?.outcome).toBe("partial")
    expect(turn?.reason).toBe("degenerate-loop")
    // The report, then six refused calls: the first is new, the next five repeat its progress signature, and the fifth repeat stops the run.
    const requests = turn?.requests ?? []
    expect(requests).toHaveLength(7)
    expect(requests.length).toBeLessThan(MAX_STEPS)
    expect(ran.recalls).toEqual(Array.from({ length: 6 }, () => ({ isError: true, view: failureShown(headShown) })))
    // Every refusal the model was shown is the same value, whatever offset it asked from.
    expect(requests.at(-1)?.results.slice(1)).toEqual(Array.from({ length: 5 }, () => ({ name: "recall_context", result: failureShown(headShown) })))
  })

  test.each([
    { stepping: "one character at a time", stride: 1 },
    { stepping: "1,000 characters at a time", stride: 1_000 },
    { stepping: "1,333 characters at a time, the longest stride that keeps six calls inside one page", stride: STOPPED_STRIDE },
  ])("a model that reads on from the notice and then steps $stepping, inside the page it just read, is stopped by the loop's breaker", async ({ stride }) => {
    // The first call is the one the notice asks for. Every later one starts inside the page that call returned: each got a page of its own before, nearly all of it text the request held.
    const asking = Array.from({ length: MAX_STEPS }, (_, index) => recall(`s${index + 1}`, () => BOUND + index * stride))
    const ran = await Effect.runPromise(runTurns(plugin, [[fetchNorth, ...asking]]))
    const [turn] = ran.turns
    expect(turn?.outcome).toBe("partial")
    expect(turn?.reason).toBe("degenerate-loop")
    const requests = turn?.requests ?? []
    const locator = locatorOf(requests[1] ?? { calls: [], results: [] })
    // One page, then one reply for every offset inside it: the page's end, nothing of the call. Six of them end the run.
    const refusal = { isError: true, view: failureShown(pageRead(BOUND + RECALL_PAGE)) }
    expect(ran.recalls).toEqual([{ isError: false, view: page(locator, BOUND) }, ...Array.from({ length: 6 }, () => refusal)])
    expect(requests).toHaveLength(8)
    expect(requests.length).toBeLessThan(MAX_STEPS)
    // The request never held more than the report's shown start and that one page.
    expect(requests.at(-1)?.results.filter((result) => !String(result.result).startsWith("{"))).toEqual([
      { name: "fetch_report", result: bounded(locator) }, { name: "recall_context", result: page(locator, BOUND) },
    ])
  })

  test("a model that steps one character more than that stride leaves each page before the sixth refusal, and reads only new pages to the step limit", async () => {
    // The bound the guides state: 1,333 characters, from the 8,000-character page and the breaker's five repeats.
    expect(STOPPED_STRIDE).toBe(1_333)
    const stride = STOPPED_STRIDE + 1
    const asking = Array.from({ length: MAX_STEPS }, (_, index) => recall(`w${index + 1}`, () => BOUND + index * stride))
    const ran = await Effect.runPromise(runTurns(plugin, [[fetchNorth, ...asking]]))
    const [turn] = ran.turns
    expect(turn?.outcome).toBe("partial")
    expect(turn?.reason).toBe("step-cap")
    const requests = turn?.requests ?? []
    expect(requests).toHaveLength(MAX_STEPS)
    const locator = locatorOf(requests[1] ?? { calls: [], results: [] })
    // Five refusals inside a page, then the first offset past it: a page of new text, which starts the breaker's count again. No page holds text another returned.
    const served = [BOUND, BOUND + 6 * stride, BOUND + 12 * stride, BOUND + 18 * stride]
    expect(ran.recalls.filter((recalled) => !recalled.isError)).toEqual(served.map((from) => ({ isError: false, view: page(locator, from) })))
    expect(ran.recalls.filter((recalled) => recalled.isError)).toHaveLength(MAX_STEPS - 1 - served.length)
  })

  test.each([
    { stepping: "1,000 characters at a time", stride: 1_000 },
    { stepping: "100 characters at a time", stride: 100 },
  ])("a model that reads a page far into the report and then steps down $stepping is served only the text it does not have", async ({ stride }) => {
    // Each call starts a little below the page the call before it read. A whole page from there is that page again, all but `stride` characters of it.
    const top = 60_000
    const asking = Array.from({ length: MAX_STEPS }, (_, index) => recall(`d${index + 1}`, () => top - index * stride))
    const ran = await Effect.runPromise(runTurns(plugin, [[fetchNorth, ...asking]]))
    const [turn] = ran.turns
    // Every call returns text the request lacks, so the breaker counts no repeat and the run ends at the step limit: within the budget, where a whole page a call failed it.
    expect(turn?.outcome).toBe("partial")
    expect(turn?.reason).toBe("step-cap")
    const requests = turn?.requests ?? []
    expect(requests).toHaveLength(MAX_STEPS)
    const locator = locatorOf(requests[1] ?? { calls: [], results: [] })
    // The first page is whole. Each later one ends where the page before it starts, and names the offset after all of them.
    expect(ran.recalls).toEqual([
      { isError: false, view: page(locator, top) },
      ...Array.from({ length: MAX_STEPS - 2 }, (_, index) => ({ isError: false, view: cutPage(locator, top - (index + 1) * stride, top - index * stride, top + RECALL_PAGE) })),
    ])
    // What the last request holds of the report through recall_context: each character once, from the lowest offset asked to the first page's end.
    const held = (requests.at(-1)?.results ?? []).filter((result) => result.name === "recall_context").map((result) => pageBody(String(result.result)))
    const lowest = top - (held.length - 1) * stride
    expect(held.reduce((sum, body) => sum + body.length, 0)).toBe(top + RECALL_PAGE - lowest)
    expect(held.toReversed().join("")).toBe(north.slice(lowest, top + RECALL_PAGE))
  })

  test("a result of an earlier turn is served as before, from any offset and as often as asked", async () => {
    const ran = await Effect.runPromise(runTurns(plugin, [
      [fetchNorth, () => stop("The north report is fetched.")],
      [recall("e1", () => undefined), recall("e2", () => undefined), () => stop("It ends with line 1600.")],
    ]))
    expect(ran.turns.map((turn) => turn.outcome)).toEqual(["completed", "completed"])
    const second = ran.turns[1]?.requests ?? []
    const locator = locatorOf(second[0] ?? { calls: [], results: [] })
    // The report is still shown through its first 16,000 characters, and its first page is returned each time: the guard is the current turn's only.
    expect(second.at(-1)?.results).toEqual([
      { name: "fetch_report", result: bounded(locator) },
      { name: "recall_context", result: page(locator, 0) },
      { name: "recall_context", result: page(locator, 0) },
    ])
    expect(ran.recalls.map((result) => result.isError)).toEqual([false, false])
  })

  test("two calls for one page made together in one response: the second is refused when they run one after another, both are served when they run at once", async () => {
    const together = (request: Seen): Part => [
      ...["t1", "t2"].map((id) => ({ type: "tool-call", id, name: "recall_context", params: { locator: locatorOf(request), offset: BOUND } })),
      { type: "finish", reason: "tool-calls", usage },
    ]
    const script = [fetchNorth, together, () => stop("The next page is read.")]
    const answers = (ran: { readonly turns: ReadonlyArray<{ readonly requests: ReadonlyArray<Seen> }> }) => {
      const requests = ran.turns[0]?.requests ?? []
      return { locator: locatorOf(requests[1] ?? { calls: [], results: [] }), results: requests.at(-1)?.results.slice(1) }
    }
    // A turn runs a response's calls one after another by default: the first call's page is recorded before the second is checked.
    const inOrder = answers(await Effect.runPromise(runTurns(plugin, [script])))
    expect(inOrder.results).toEqual([
      { name: "recall_context", result: page(inOrder.locator, BOUND) },
      { name: "recall_context", result: failureShown(pageRead(BOUND + RECALL_PAGE)) },
    ])
    // Run at once, neither has a result when the other is checked: both return the page. Known and accepted.
    const atOnce = answers(await Effect.runPromise(runTurns(plugin, [script], { toolConcurrency: 2 })))
    expect(atOnce.results).toEqual([
      { name: "recall_context", result: page(atOnce.locator, BOUND) },
      { name: "recall_context", result: page(atOnce.locator, BOUND) },
    ])
  })

  test("a refusal read in the next turn still leads to text the request does not show", async () => {
    // The first turn fetches a table, whose tool has a compact view, and asks for its shown start. The second turn's model reads that reply again and follows it.
    const ran = await Effect.runPromise(runTurns(plugin, [
      [() => call("f1", "fetch_table", { name: "north" }), recall("r1", () => undefined), () => stop("The north table is fetched.")],
      [followReply("r2"), () => stop("The north table is read.")],
    ]))
    expect(ran.turns.map((turn) => turn.outcome)).toEqual(["completed", "completed"])
    const first = ran.turns[0]?.requests ?? []
    const second = ran.turns[1]?.requests ?? []
    const locator = locatorOf(first[1] ?? { calls: [], results: [] })
    // What the second turn shows of the table: the window strategy has given it its compact view, the summary strategy still shows its bounded start.
    const shown = strategy === "window" ? compactTable("north") : bounded(locator)
    // Where the text the request lacks starts: the table's start once only its compact view is shown, else the offset of its notice.
    const unread = strategy === "window" ? 0 : BOUND
    expect(second[0]?.results[0]).toEqual({ name: "fetch_table", result: shown })
    // The model that follows the reply reads from there: nothing between what it is shown and what it is given is skipped.
    expect(second.at(-1)?.results.at(-1)).toEqual({ name: "recall_context", result: page(locator, unread) })
    // The reply it followed is the first turn's, as it was written.
    expect(second[0]?.results[1]).toEqual({ name: "recall_context", result: failureShown(headShown) })
    expect(ran.recalls).toEqual([{ isError: true, view: failureShown(headShown) }, { isError: false, view: page(locator, unread) }])
  })

  test("a refusal for a page already read, read in the next turn, still has that page above it", async () => {
    // The first turn reads the page after the report's shown start, then asks from inside it. The second turn's model reads that reply again and follows it.
    const ran = await Effect.runPromise(runTurns(plugin, [
      [fetchNorth, recall("p1", () => BOUND), recall("p2", () => BOUND + 4_000), () => stop("The north report is read on.")],
      [followReply("p3"), () => stop("The north report is read further.")],
    ]))
    expect(ran.turns.map((turn) => turn.outcome)).toEqual(["completed", "completed"])
    const first = ran.turns[0]?.requests ?? []
    const second = ran.turns[1]?.requests ?? []
    const locator = locatorOf(first[1] ?? { calls: [], results: [] })
    // The next turn's first request: the report's shown start, the page, then the reply that calls that page shown above. The reply names no turn.
    expect(second[0]?.results).toEqual([
      { name: "fetch_report", result: bounded(locator) },
      { name: "recall_context", result: page(locator, BOUND) },
      { name: "recall_context", result: failureShown(pageRead(BOUND + RECALL_PAGE)) },
    ])
    // Followed there, the offset it names is the page after: nothing is skipped, and nothing the request shows is returned again.
    expect(second.at(-1)?.results.at(-1)).toEqual({ name: "recall_context", result: page(locator, BOUND + RECALL_PAGE) })
  })
}))

describe("recall_context and a refusal the window strategy's pressure makes old", () => {
  /** A budget the second report passes: the request before it holds one bounded result, the one after it would hold two. */
  const BUDGET = 9_000

  test("a refusal read after the result was spilled again under pressure leads to the new notice's offset", async () => {
    const ran = await Effect.runPromise(runTurns(memoryWindowPlugin, [[
      fetchNorth,
      recall("r1", () => undefined),
      // A second report passes the budget: the window spills the first one to its 600-character preview.
      () => call("f2", "fetch_report", { name: "south" }),
      // The model reads the reply to its first call again, and follows it.
      followReply("r2"),
      () => stop("The north report is read on."),
    ]], {}, BUDGET))
    const [turn] = ran.turns
    expect(turn?.outcome).toBe("completed")
    const requests = turn?.requests ?? []
    const locator = locatorOf(requests[1] ?? { calls: [], results: [] })
    // The request after the second report: the first report is its first 600 characters and a notice that says so.
    expect(requests[3]?.results[0]).toEqual({ name: "fetch_report", result: shortened(locator, 600) })
    // The refusal, followed there, reads on from character 600: the text between the new preview and the old one is not skipped.
    expect(requests.at(-1)?.results.at(-1)).toEqual({ name: "recall_context", result: page(locator, 600) })
    // It is the reply to the first call, as it was written.
    expect(requests[3]?.results[1]).toEqual({ name: "recall_context", result: failureShown(headShown) })
    expect(ran.recalls).toEqual([{ isError: true, view: failureShown(headShown) }, { isError: false, view: page(locator, 600) }])
  })

  test("a refusal read after pressure gave the earlier result its compact view leads to the result's start", async () => {
    // With compactPreviousTurn off, the table keeps its bounded start across the turn's start; the second turn's report passes the budget, and the table takes its compact view.
    const ran = await Effect.runPromise(runTurns({ plugin: memoryWindowPlugin, options: { compactPreviousTurn: false } }, [
      [() => call("f1", "fetch_table", { name: "north" }), recall("r1", () => undefined), () => stop("The north table is fetched.")],
      [() => call("f2", "fetch_report", { name: "south" }), followReply("r2"), () => stop("The north table is read.")],
    ], {}, BUDGET))
    expect(ran.turns.map((turn) => turn.outcome)).toEqual(["completed", "completed"])
    const first = ran.turns[0]?.requests ?? []
    const second = ran.turns[1]?.requests ?? []
    const locator = locatorOf(first[1] ?? { calls: [], results: [] })
    // The turn's start rewrote nothing: its first request shows the table as the first turn left it.
    expect(second[0]?.results[0]).toEqual({ name: "fetch_table", result: bounded(locator) })
    // Over budget, the table is its compact view, with no notice.
    expect(second[1]?.results[0]).toEqual({ name: "fetch_table", result: compactTable("north") })
    // The refusal, followed there, reads the table from its start.
    expect(second.at(-1)?.results.at(-1)).toEqual({ name: "recall_context", result: page(locator, 0) })
    // It is the first turn's reply, as it was written.
    expect(second[1]?.results[1]).toEqual({ name: "recall_context", result: failureShown(headShown) })
  })
})
