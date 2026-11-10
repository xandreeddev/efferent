import { describe, expect, test } from "bun:test"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import { Array as Arr, Context, Effect, Layer, Option, Order, Ref, Schema, Stream } from "effect"
import { ConversationId, defineCapability, defineSkill, defineTool, entriesOfEvents, Failure, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage, UtilityCompletion, UtilityLlm } from "@xandreed/core"
import type { CompactionAction, Turn, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"
import type { AgentConfig } from "./agent.adapter.js"

/*
 * A host tool with no view returns four reports of about 69,000 characters
 * each in one turn, under the default 64,000-token budget. Whole, the four
 * would not fit one request. Bounded as they are written, each is shown as
 * its first 16,000 characters and a notice from the first request that
 * includes it, so every request fits, no result is shortened again and the
 * prefix a provider caches never changes; `recall_context` reads the next
 * page of a report by the locator its notice shows. Both memory strategies
 * are run. With `boundOnWriteChars: 0` the same results are shown whole.
 * Also run: calls made together in one step and the first request of the
 * next turn, a tool's own `boundOnWriteChars` annotation, a summary session
 * bounded at the default and continued at `0`, and a turn whose bounded
 * results pass the budget together under each strategy.
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
  id: "bound-on-write-host", version: "1",
  tools: [defineTool({ tool: FetchReport, handler: ({ name }) => Effect.succeed(report(name)), annotations: { readOnly: true } })],
  skills: [defineSkill({ id: "core", summary: "Fetch reports.", tools: ["fetch_report"], always: true })],
})

/** The same report from two more tools, each with a bound of its own: `0` keeps the result whole, 40,000 replaces the strategy's 16,000. */
const FetchWhole = Tool.make("fetch_whole", { description: "Fetch a whole report by its name.", parameters: Schema.Struct({ name: Schema.String }), success: Schema.String, failure: Failure, failureMode: "return" })
const FetchWide = Tool.make("fetch_wide", { description: "Fetch a wide report by its name.", parameters: Schema.Struct({ name: Schema.String }), success: Schema.String, failure: Failure, failureMode: "return" })
const WIDE_BOUND = 40_000
const annotated = defineCapability({
  id: "bound-on-write-annotated", version: "1",
  tools: [
    defineTool({ tool: FetchReport, handler: ({ name }) => Effect.succeed(report(name)), annotations: { readOnly: true } }),
    defineTool({ tool: FetchWhole, handler: ({ name }) => Effect.succeed(report(name)), annotations: { readOnly: true, boundOnWriteChars: 0 } }),
    defineTool({ tool: FetchWide, handler: ({ name }) => Effect.succeed(report(name)), annotations: { readOnly: true, boundOnWriteChars: WIDE_BOUND } }),
  ],
  skills: [defineSkill({ id: "core", summary: "Fetch reports.", tools: ["fetch_report", "fetch_whole", "fetch_wide"], always: true })],
})

const names = ["north", "south", "east", "west"] as const
const BOUND = 16_000
const RECALL_PAGE = 8_000
const BUDGET = 64_000

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, name: string, params: unknown): Part => [{ type: "tool-call", id, name, params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]
const encodePrompt = Schema.encodeSync(Prompt.Prompt)

/** A model request as the journey reads it: each message as the bytes sent, the tool results in order, the tools offered. */
interface Seen {
  readonly messages: ReadonlyArray<string>
  readonly results: ReadonlyArray<{ readonly name: string; readonly result: unknown }>
  readonly tools: ReadonlyArray<string>
}

/** A settled model: each step of `script` answers from the request it is given, which is recorded. */
const scripted = (seen: Ref.Ref<ReadonlyArray<Seen>>, script: ReadonlyArray<(request: Seen) => Part>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      const prompt = encodePrompt(options.prompt)
      const request: Seen = {
        messages: prompt.content.map((message) => JSON.stringify(message)),
        results: prompt.content.flatMap((message) => message.role === "tool" ? message.content.flatMap((part) => part.type === "tool-result" ? [{ name: part.name, result: part.result }] : []) : []),
        tools: Arr.sort(options.tools.map((tool) => tool.name), Order.String),
      }
      yield* Ref.update(seen, (all) => [...all, request])
      return (script[index]?.(request) ?? stop("done")) as never
    }),
    streamText: () => Stream.die("not scripted"),
  })
})

const runToStop = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({ limits: { requireCompletion: false } })),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
)

/** The notice a bounded result ends with, as core's `spillPreview` writes it. */
const notice = (left: number, locator: string, offset: number) =>
  `[… ${left} more characters kept out of context; call recall_context with locator "${locator}" and offset ${offset} to read them]`
/** The locator and offset the notice of a shortened result gives. */
const continuationOf = (result: unknown) => Option.map(Option.fromNullishOr(/locator "([^"]+)" and offset (\d+) to read them\]$/.exec(String(result))), (found) => ({ locator: found[1] ?? "", offset: Number(found[2]) }))

const decodeBuilt = Schema.decodeUnknownSync(Schema.Struct({ estimatedTokens: Schema.Int, reservedTokens: Schema.Int, budgetTokens: Schema.Int, compactions: Schema.Int, strategyVersion: Schema.String }))

/** One turn of a session: the memory plugin its agent is defined with, and what the model answers at each step. */
interface ScriptedTurn {
  readonly memory: AgentConfig["plugins"][number]
  readonly script: ReadonlyArray<(request: Seen) => Part>
}

/**
 * The turns of `turns`, in order, in one fresh session, each run by an agent
 * defined with that turn's memory plugin (a host that changes its options
 * between turns defines its agent again): every request the model saw in
 * each turn, each step's `context.built` and the compactions stored.
 */
const runTurns = (turns: ReadonlyArray<ScriptedTurn>, budgetTokens: number, options: { readonly maxSteps?: number; readonly capabilities?: AgentConfig["capabilities"] } = {}) => Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: ConversationId.make("00000000-0000-4000-8000-0000b0a2d0e1"), owner: "bound-on-write-journey" }
  yield* sessions.create({ owner: address.owner, id: address.id })
  const summaries = yield* Ref.make(0)
  // The summary strategy reads a summarizer where its session opens; nothing in these turns passes its trigger.
  const utility = UtilityLlm.of({ complete: () => Ref.update(summaries, (count) => count + 1).pipe(
    Effect.as(new UtilityCompletion({ text: "SUMMARY", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }))) })
  const ran = yield* Effect.forEach(turns, ({ memory, script }, index) => Effect.gen(function* () {
    const agent = yield* Agent.define({
      plugins: [memory, toolDiscoveryPlugin, stepLoopPlugin],
      capabilities: options.capabilities ?? [host],
      turnServices: [LanguageModel.LanguageModel, UtilityLlm],
      limits: { streaming: false, maxSteps: options.maxSteps ?? 8 },
      system: "Answer from the reports.",
      budgetTokens,
    })
    const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
    const model = yield* scripted(seen, script)
    const outcome = yield* agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: index === 0 ? "compare the four regional reports" : "and what follows from them?" }), runId: RunId.make(`run-${index + 1}`) },
      services: Context.mergeAll(Context.make(LanguageModel.LanguageModel, model), Context.make(UtilityLlm, utility), Context.make(Sessions, sessions)),
    }, runToStop)
    return { outcome: outcome.outcome, requests: yield* Ref.get(seen) }
  }), { concurrency: 1 })
  const stored = yield* sessions.read(address)
  const entries = yield* entriesOfEvents(stored)
  return {
    turns: ran,
    built: stored.filter((event) => event.kind === "context.built").map((event) => decodeBuilt(event.data)),
    compactions: entries.flatMap((entry) => entry.body._tag === "Compaction" ? [{ strategy: entry.body.strategy, version: entry.body.version, action: entry.body.action }] : []),
    /** The stored view of each report, by its entry id: what a locator resolves to. */
    stored: new Map(entries.flatMap((entry) => entry.body._tag === "ToolResult" && entry.body.toolName.startsWith("fetch_") ? [[String(entry.id), entry.body.view] as const] : [])),
    summaries: yield* Ref.get(summaries),
  }
}))

/** One turn of `script` in a fresh session under `memory`. */
const runTurn = (memory: AgentConfig["plugins"][number], budgetTokens: number, script: ReadonlyArray<(request: Seen) => Part>, maxSteps = 8) =>
  runTurns([{ memory, script }], budgetTokens, { maxSteps }).pipe(Effect.map((ran) => ({ ...ran, outcome: ran.turns[0]?.outcome, requests: ran.turns[0]?.requests ?? [] })))

/** The compactions stored, each as the entry it shortens and the text it shows; one that is no spill names its action instead. */
const spillsOf = (compactions: ReadonlyArray<{ readonly strategy: string; readonly version: string; readonly action: CompactionAction }>): ReadonlyArray<{ readonly strategy: string; readonly version: string; readonly spilled: string; readonly preview: string }> =>
  compactions.map((compaction) => ({
    strategy: compaction.strategy, version: compaction.version,
    ...(compaction.action._tag === "Spill" ? { spilled: String(compaction.action.entry), preview: compaction.action.preview } : { spilled: `not a spill: ${compaction.action._tag}`, preview: "" }),
  }))
const bySpilled = Order.mapInput(Order.String, (spill: { readonly spilled: string }) => spill.spilled)

const fetches = names.map((name, index) => () => call(`f${index + 1}`, "fetch_report", { name }))
/** After the four reports: read the next page of the first one, by the locator and offset its notice gives. */
const recallNext = (request: Seen): Part => Option.match(continuationOf(request.results[0]?.result), {
  onNone: () => stop("the first report shows no locator"),
  onSome: ({ locator, offset }) => call("r1", "recall_context", { locator, offset }),
})

const strategies = [
  { plugin: memoryWindowPlugin, strategy: "window", version: "4" },
  { plugin: memorySummaryPlugin, strategy: "summary", version: "2" },
] as const

strategies.map(({ plugin, strategy, version }) => describe(`results bounded as they are written, under the ${strategy} strategy`, () => {
  test("four results far above the bound fit one turn's budget, each shown from its first request as its head and a locator", async () => {
    const turn = await Effect.runPromise(runTurn(plugin, BUDGET, [...fetches, recallNext, () => stop("The four reports are compared.")]))
    expect(turn.outcome).toBe("completed")
    expect(turn.requests).toHaveLength(6)
    expect(turn.requests.every((request) => request.tools.includes("recall_context"))).toBe(true)

    // Each report is recorded with its bound as it is written: one spill of the strategy's own per report, and nothing else.
    const ids = [...turn.stored.keys()]
    expect(ids).toHaveLength(4)
    const shown = names.map((name, index) => `${report(name).slice(0, BOUND)}\n${notice(report(name).length - BOUND, ids[index] ?? "", BOUND)}`)
    expect(spillsOf(turn.compactions)).toEqual(ids.map((id, index) => ({ strategy, version, spilled: id, preview: shown[index] ?? "" })))
    expect(turn.summaries).toBe(0)
    // The stored result stays whole.
    expect([...turn.stored.values()]).toEqual(names.map(report))

    // The request after each fetch shows the report bounded, and every later request shows the same text.
    expect(turn.requests.map((request) => request.results.filter((result) => result.name === "fetch_report").map((result) => result.result)))
      .toEqual([[], shown.slice(0, 1), shown.slice(0, 2), shown.slice(0, 3), shown, shown])

    // Every request stays within the budget, with room to spare: whole, the four reports alone would pass it.
    expect(turn.built).toHaveLength(6)
    expect(turn.built.every((step) => step.budgetTokens === BUDGET && step.estimatedTokens + step.reservedTokens <= BUDGET / 2)).toBe(true)
    expect(Math.ceil(names.map(report).join("").length / 3)).toBeGreaterThan(BUDGET)
    // `context.built` counts each bound among the compactions applied.
    expect(turn.built.map((step) => step.compactions)).toEqual([0, 1, 2, 3, 4, 4])
    expect(new Set(turn.built.map((step) => step.strategyVersion))).toEqual(new Set([version]))
  })

  test("the request prefix that holds a bounded result is byte-identical on every later step", async () => {
    const turn = await Effect.runPromise(runTurn(plugin, BUDGET, [...fetches, recallNext, () => stop("The four reports are compared.")]))
    const prefixes = turn.requests.slice(1).map((request, index) => {
      const earlier = turn.requests[index]?.messages ?? []
      return { grew: request.messages.length > earlier.length, same: earlier.every((message, at) => message === request.messages[at]) }
    })
    expect(prefixes).toEqual(turn.requests.slice(1).map(() => ({ grew: true, same: true })))
    // The system prompt, the user's message, then a call and its result per step.
    expect(turn.requests.map((request) => request.messages.length)).toEqual([2, 4, 6, 8, 10, 12])
  })

  test("recall_context returns the next page of a bounded result, whole", async () => {
    const turn = await Effect.runPromise(runTurn(plugin, BUDGET, [...fetches, recallNext, () => stop("The four reports are compared.")]))
    const [locator] = [...turn.stored.keys()]
    const north = report("north")
    const recalled = turn.requests.at(-1)?.results.filter((result) => result.name === "recall_context")
    expect(recalled).toEqual([{
      name: "recall_context",
      result: `${north.slice(BOUND, BOUND + RECALL_PAGE)}\n[… ${north.length - BOUND - RECALL_PAGE} more characters; call recall_context with locator "${locator}" and offset ${BOUND + RECALL_PAGE}]`,
    }])
  })

  test("with boundOnWriteChars: 0 the results are whole as today", async () => {
    // A budget the four whole reports fit: nothing is under pressure, so nothing shortens them.
    const turn = await Effect.runPromise(runTurn({ plugin, options: { boundOnWriteChars: 0 } }, 200_000, [...fetches, () => stop("The four reports are compared.")]))
    expect(turn.outcome).toBe("completed")
    expect(turn.compactions).toEqual([])
    expect(turn.requests.map((request) => request.results.map((result) => result.result)))
      .toEqual([[], names.slice(0, 1).map(report), names.slice(0, 2).map(report), names.slice(0, 3).map(report), names.map(report)])
    expect(turn.built.map((step) => step.compactions)).toEqual([0, 0, 0, 0, 0])
    // Both strategies offer recall_context whatever the bound is: a session may hold results bounded earlier, whose notice names it.
    expect(turn.requests.map((request) => request.tools)).toEqual(turn.requests.map(() => ["fetch_report", "load_skill", "recall_context"]))
  })

  test("calls made together in one step are each bounded as they return, and the next turn's first request starts with the same messages", async () => {
    const together: Part = [...names.map((name, index) => ({ type: "tool-call", id: `p${index + 1}`, name: "fetch_report", params: { name } })), { type: "finish", reason: "tool-calls", usage }]
    const ran = await Effect.runPromise(runTurns([
      { memory: plugin, script: [() => together, () => stop("The four reports are read.")] },
      { memory: plugin, script: [() => stop("Nothing more follows.")] },
    ], BUDGET))
    expect(ran.turns.map((turn) => turn.outcome)).toEqual(["completed", "completed"])
    // Results are stored as they return: each report's locator is found by its stored view.
    const locatorOf = (name: string) => [...ran.stored].flatMap(([id, view]) => view === report(name) ? [id] : []).at(0) ?? "missing"
    expect(new Set(names.map(locatorOf)).size).toBe(names.length)
    const shown = names.map((name) => `${report(name).slice(0, BOUND)}\n${notice(report(name).length - BOUND, locatorOf(name), BOUND)}`)
    // One spill of the strategy's own per report and nothing else, whatever order the results returned in.
    expect(Arr.sort(spillsOf(ran.compactions), bySpilled)).toEqual(Arr.sort(names.map((name, index) => ({ strategy, version, spilled: locatorOf(name), preview: shown[index] ?? "" })), bySpilled))
    // The request after the step shows the four in the order of their calls, each bounded from this first request.
    const [first, second] = [ran.turns[0]?.requests ?? [], ran.turns[1]?.requests ?? []]
    expect(first.map((request) => request.results.map((result) => result.result))).toEqual([[], shown])
    // The next turn's first request is the last one of this turn, byte for byte, then the reply and the new message.
    const last = first.at(-1)?.messages ?? []
    const next = second.at(0)?.messages ?? []
    expect(last).toHaveLength(4)
    expect(next.slice(0, last.length)).toEqual([...last])
    expect(next).toHaveLength(last.length + 2)
    expect(second.at(0)?.results.map((result) => result.result)).toEqual(shown)
    expect(ran.summaries).toBe(0)
  })

  test("a tool's own boundOnWriteChars annotation decides what its result shows: whole at 0, cut at its own bound", async () => {
    const ran = await Effect.runPromise(runTurns([{ memory: plugin, script: [
      () => call("a1", "fetch_report", { name: "north" }), () => call("a2", "fetch_whole", { name: "south" }), () => call("a3", "fetch_wide", { name: "east" }),
      () => stop("The three are read."),
    ] }], BUDGET, { capabilities: [annotated] }))
    expect(ran.turns.map((turn) => turn.outcome)).toEqual(["completed"])
    const ids = [...ran.stored.keys()]
    expect(ids).toHaveLength(3)
    const [north, south, east] = [report("north"), report("south"), report("east")]
    const bounded = `${north.slice(0, BOUND)}\n${notice(north.length - BOUND, ids[0] ?? "", BOUND)}`
    const wide = `${east.slice(0, WIDE_BOUND)}\n${notice(east.length - WIDE_BOUND, ids[2] ?? "", WIDE_BOUND)}`
    // The strategy's bound for the tool that sets none, the whole result for the tool that sets 0, the tool's own bound for the third.
    expect(ran.turns[0]?.requests.at(-1)?.results).toEqual([
      { name: "fetch_report", result: bounded }, { name: "fetch_whole", result: south }, { name: "fetch_wide", result: wide },
    ])
    // Each is shown that way from the first request that includes it, and only the two cut ones have a bound recorded.
    expect(ran.turns[0]?.requests.map((request) => request.results.map((result) => result.result))).toEqual([[], [bounded], [bounded, south], [bounded, south, wide]])
    expect(spillsOf(ran.compactions)).toEqual([{ strategy, version, spilled: ids[0] ?? "", preview: bounded }, { strategy, version, spilled: ids[2] ?? "", preview: wide }])
  })
}))

test("a summary session bounded at the default and continued with boundOnWriteChars: 0 still offers recall_context, which reads the earlier result on", async () => {
  const ran = await Effect.runPromise(runTurns([
    { memory: memorySummaryPlugin, script: [() => call("f1", "fetch_report", { name: "north" }), () => stop("North is read.")] },
    // The host has since turned the bound off: nothing more is bounded, and the result bounded earlier keeps its notice.
    { memory: { plugin: memorySummaryPlugin, options: { boundOnWriteChars: 0 } }, script: [recallNext, () => call("f2", "fetch_report", { name: "south" }), () => stop("Both are read.")] },
  ], BUDGET))
  expect(ran.turns.map((turn) => turn.outcome)).toEqual(["completed", "completed"])
  const [locator] = [...ran.stored.keys()]
  const [north, south] = [report("north"), report("south")]
  const bounded = `${north.slice(0, BOUND)}\n${notice(north.length - BOUND, locator ?? "", BOUND)}`
  const second = ran.turns[1]?.requests ?? []
  expect(second).toHaveLength(3)
  // The notice the second turn's first request shows names a tool that request offers.
  expect(second.map((request) => request.tools)).toEqual(second.map(() => ["fetch_report", "load_skill", "recall_context"]))
  expect(second.at(0)?.results).toEqual([{ name: "fetch_report", result: bounded }])
  // The tool reads on from the notice's offset.
  expect(second.at(1)?.results).toEqual([{ name: "fetch_report", result: bounded }, {
    name: "recall_context",
    result: `${north.slice(BOUND, BOUND + RECALL_PAGE)}\n[… ${north.length - BOUND - RECALL_PAGE} more characters; call recall_context with locator "${locator}" and offset ${BOUND + RECALL_PAGE}]`,
  }])
  // A result written at 0 is whole, and the one bound of the first turn is the only one stored.
  expect(second.at(2)?.results.at(-1)).toEqual({ name: "fetch_report", result: south })
  expect(spillsOf(ran.compactions)).toEqual([{ strategy: "summary", version: "2", spilled: locator ?? "", preview: bounded }])
})

test("under the summary strategy bounded results that pass the budget together are sent as they are: nothing reduces the current turn", async () => {
  // The fourteen reports of the window test below: about 75,000 estimated tokens once bounded, over the 64,000-token budget.
  const regions = Array.from({ length: 14 }, (_, index) => `region-${String(index + 1).padStart(2, "0")}`)
  const turn = await Effect.runPromise(runTurn(memorySummaryPlugin, BUDGET, [
    ...regions.map((name, index) => () => call(`g${index + 1}`, "fetch_report", { name })), () => stop("All fourteen are read."),
  ], 16))
  expect(turn.outcome).toBe("completed")
  // Each report has its bound and no other compaction is stored: the summary strategy folds earlier turns, and there is none.
  const ids = [...turn.stored.keys()]
  expect(spillsOf(turn.compactions).map((spill) => spill.spilled)).toEqual(ids)
  expect(turn.summaries).toBe(0)
  // The last request shows all fourteen at their bound and is over the budget: a host sizes the bound or the budget for its turns.
  expect(turn.requests.at(-1)?.results.map((result) => Option.map(continuationOf(result.result), (found) => found.offset))).toEqual(ids.map(() => Option.some(BOUND)))
  const last = turn.built.at(-1)
  expect((last?.estimatedTokens ?? 0) + (last?.reservedTokens ?? 0)).toBeGreaterThan(BUDGET)
})

test("results that pass the budget together, though each is bounded, are spilled again under pressure instead of failing the turn", async () => {
  // Fourteen bounded reports show about 75,000 estimated tokens together: more than the window's 64,000-token budget.
  const regions = Array.from({ length: 14 }, (_, index) => `region-${String(index + 1).padStart(2, "0")}`)
  const turn = await Effect.runPromise(runTurn(memoryWindowPlugin, BUDGET, [
    ...regions.map((name, index) => () => call(`g${index + 1}`, "fetch_report", { name })), () => stop("All fourteen are read."),
  ], 16))
  expect(turn.outcome).toBe("completed")
  expect(turn.requests).toHaveLength(15)
  const ids = [...turn.stored.keys()]
  const spills = turn.compactions.flatMap((compaction) => compaction.action._tag === "Spill" ? [{ entry: String(compaction.action.entry), offset: Option.map(continuationOf(compaction.action.preview), (found) => found.offset) }] : [])
  // Each report was bounded as it was written; under pressure some were spilled again, to the shorter pressure preview.
  expect(turn.compactions.every((compaction) => compaction.action._tag === "Spill")).toBe(true)
  expect(spills.filter((spill) => Option.contains(spill.offset, BOUND)).map((spill) => spill.entry)).toEqual(ids)
  const again = spills.filter((spill) => Option.contains(spill.offset, 600)).map((spill) => spill.entry)
  expect(again.length).toBeGreaterThan(0)
  expect(again.length).toBeLessThan(ids.length)
  expect(new Set(again).size).toBe(again.length)
  expect(again.every((entry) => ids.includes(entry))).toBe(true)
  // Every request fits the budget, and the last one still shows most reports through their first 16,000 characters.
  expect(turn.built.every((step) => step.estimatedTokens + step.reservedTokens <= step.budgetTokens)).toBe(true)
  const last = turn.requests.at(-1)?.results.map((result) => continuationOf(result.result)) ?? []
  expect(last.filter((found) => Option.exists(found, (continuation) => continuation.offset === 600))).toHaveLength(again.length)
  expect(last.filter((found) => Option.exists(found, (continuation) => continuation.offset === BOUND))).toHaveLength(ids.length - again.length)
})
