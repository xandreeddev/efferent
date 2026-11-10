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
 * instead for text the request already shows (the report's start, or a page
 * it read a step ago) gets no text again: the reply says where to read on
 * from, the model follows it, and one that keeps asking is stopped by the
 * step loop's breaker long before the step limit. A report of an earlier
 * turn is served as before. Two calls for one page made together in one
 * response: the second is refused when a turn runs its calls one after
 * another, as it does by default, and both are served when they run at once.
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

// No view: the model is shown the returned text as it is.
const host = defineCapability({
  id: "recall-guard-host", version: "1",
  tools: [defineTool({ tool: FetchReport, handler: ({ name }) => Effect.succeed(report(name)), annotations: { readOnly: true } })],
  skills: [defineSkill({ id: "core", summary: "Fetch reports.", tools: ["fetch_report"], always: true })],
})

const BOUND = 16_000
const RECALL_PAGE = 8_000
const north = report("north")

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]
const encodePrompt = Schema.encodeSync(Prompt.Prompt)

/** A model request as the journey reads it: its tool results, in order. */
interface Seen {
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
        results: prompt.content.flatMap((message) => message.role === "tool" ? message.content.flatMap((part) => part.type === "tool-result" ? [{ name: part.name, result: part.result }] : []) : []),
      }
      yield* Ref.update(seen, (all) => [...all, request])
      return (script[index]?.(request) ?? stop("done")) as never
    }),
    streamText: () => Stream.die("not scripted"),
  })
})

/** The locator the notice of the first result, the report, gives. */
const locatorOf = (request: Seen): string => /locator "([^"]+)" and offset \d+ to read them\]$/.exec(String(request.results[0]?.result))?.[1] ?? "no locator shown"
/** A returned failure as the model is shown it: the result's text, its JSON with the keys in order. */
const failureShown = (failure: Failure): string => JSON.stringify({ error: failure.error, message: failure.message })
/** The offset the last reply tells the model to pass, when it is a failure that names one. */
const offsetToPass = (request: Seen): Option.Option<number> => Option.map(
  Option.flatMap(Schema.decodeUnknownOption(Schema.fromJsonString(Failure))(request.results.at(-1)?.result), (failure) => Option.fromNullishOr(/pass offset (\d+)\.$/.exec(failure.message)?.[1])), Number)

/** The notice a bounded result ends with, and a page of the report as `recall_context` returns it. */
const bounded = (locator: string) => `${north.slice(0, BOUND)}\n[… ${north.length - BOUND} more characters kept out of context; call recall_context with locator "${locator}" and offset ${BOUND} to read them]`
const page = (locator: string, from: number) => `${north.slice(from, from + RECALL_PAGE)}\n[… ${north.length - from - RECALL_PAGE} more characters; call recall_context with locator "${locator}" and offset ${from + RECALL_PAGE}]`

const MAX_STEPS = 24

/**
 * The turns of `scripts`, in order, in one fresh session under `memory`:
 * every request the model saw in each turn, how each turn's run ended, and
 * the stored result of every `recall_context` call.
 */
const runTurns = (memory: AgentConfig["plugins"][number], scripts: ReadonlyArray<ReadonlyArray<(request: Seen) => Part>>, limits: { readonly toolConcurrency?: number } = {}) => Effect.scoped(Effect.gen(function* () {
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
  }
}))

const fetchNorth = () => call("f1", "fetch_report", { name: "north" })
const recall = (id: string, offset: (request: Seen) => number | undefined) => (request: Seen): Part => {
  const from = offset(request)
  return call(id, "recall_context", { locator: locatorOf(request), ...(from === undefined ? {} : { offset: from }) })
}

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
      // It follows the reply: the next page.
      recall("r2", (request) => Option.getOrElse(offsetToPass(request), () => -1)),
      // It asks for that page again,
      recall("r3", () => BOUND),
      // and follows the reply again.
      recall("r4", (request) => Option.getOrElse(offsetToPass(request), () => -1)),
      () => stop("The north report is read."),
    ]]))
    const [turn] = ran.turns
    expect(turn?.outcome).toBe("completed")
    expect(turn?.reason).toBe("completed")
    const requests = turn?.requests ?? []
    expect(requests).toHaveLength(6)
    const locator = locatorOf(requests[1] ?? { results: [] })
    const shown = { error: "ResultShown", message: "The first 16000 characters of this result are shown above. To read on, pass offset 16000." }
    const read = { error: "AlreadyRecalled", message: "You already read this page in this turn and it is shown above. To read on, pass offset 24000." }
    // The last request holds the whole exchange: the report bounded, then each reply of recall_context in order.
    expect(requests.at(-1)?.results).toEqual([
      { name: "fetch_report", result: bounded(locator) },
      { name: "recall_context", result: failureShown(shown) },
      { name: "recall_context", result: page(locator, BOUND) },
      { name: "recall_context", result: failureShown(read) },
      { name: "recall_context", result: page(locator, BOUND + RECALL_PAGE) },
    ])
    // Each request shows what the one before it showed, and one more reply.
    expect(requests.map((request) => request.results.length)).toEqual([0, 1, 2, 3, 4, 5])
    // A refusal is stored as the failed call's result, as any returned failure is; a page is the tool's result.
    expect(ran.recalls).toEqual([
      { isError: true, view: failureShown(shown) }, { isError: false, view: page(locator, BOUND) },
      { isError: true, view: failureShown(read) }, { isError: false, view: page(locator, BOUND + RECALL_PAGE) },
    ])
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
    const refusal = { error: "ResultShown", message: "The first 16000 characters of this result are shown above. To read on, pass offset 16000." }
    expect(ran.recalls).toEqual(Array.from({ length: 6 }, () => ({ isError: true, view: failureShown(refusal) })))
    // Every refusal the model was shown is the same value, whatever offset it asked from.
    expect(requests.at(-1)?.results.slice(1)).toEqual(Array.from({ length: 5 }, () => ({ name: "recall_context", result: failureShown(refusal) })))
  })

  test("a result of an earlier turn is served as before, from any offset and as often as asked", async () => {
    const ran = await Effect.runPromise(runTurns(plugin, [
      [fetchNorth, () => stop("The north report is fetched.")],
      [recall("e1", () => undefined), recall("e2", () => undefined), () => stop("It ends with line 1600.")],
    ]))
    expect(ran.turns.map((turn) => turn.outcome)).toEqual(["completed", "completed"])
    const second = ran.turns[1]?.requests ?? []
    const locator = locatorOf(second[0] ?? { results: [] })
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
      return { locator: locatorOf(requests[1] ?? { results: [] }), results: requests.at(-1)?.results.slice(1) }
    }
    // A turn runs a response's calls one after another by default: the first call's page is recorded before the second is checked.
    const inOrder = answers(await Effect.runPromise(runTurns(plugin, [script])))
    expect(inOrder.results).toEqual([
      { name: "recall_context", result: page(inOrder.locator, BOUND) },
      { name: "recall_context", result: failureShown({ error: "AlreadyRecalled", message: "You already read this page in this turn and it is shown above. To read on, pass offset 24000." }) },
    ])
    // Run at once, neither has a result when the other is checked: both return the page. Known and accepted.
    const atOnce = answers(await Effect.runPromise(runTurns(plugin, [script], { toolConcurrency: 2 })))
    expect(atOnce.results).toEqual([
      { name: "recall_context", result: page(atOnce.locator, BOUND) },
      { name: "recall_context", result: page(atOnce.locator, BOUND) },
    ])
  })
}))
