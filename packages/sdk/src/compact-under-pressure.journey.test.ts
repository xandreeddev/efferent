import { expect, test } from "bun:test"
import { LanguageModel, Prompt, Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { ConversationId, defineCapability, defineSkill, defineTool, entriesOfEvents, Failure, RunId, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage } from "@xandreed/core"
import type { Turn, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * A host that keeps its provider's prompt cache sets `compactPreviousTurn:
 * false`: no turn start rewrites an earlier turn, so each request starts
 * with the messages of the one before it. Three turns look records up with
 * a tool that has a compact view. The first two fit the budget. The third
 * turn's result passes it: the next request shows the earlier result whose
 * compact view frees the most through that view, and no more than the
 * budget needs: the other earlier result and the current turn's stay whole,
 * nothing is spilled and no turn is dropped. Under a budget the whole
 * conversation fits, the same turns record nothing.
 */

const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String, limit: Schema.Number }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

const records = (query: string, limit: number): string =>
  Array.from({ length: limit }, (_, index) => `record-${query}-${String(index + 1).padStart(2, "0")}: ${query} entry ${index + 1}, filed under ${query}`).join("\n")
/** What a lookup shows once its turn is over. */
const compactRecords = (query: string, limit: number): string => `${limit} ${query} records, record-${query}-01 to record-${query}-${String(limit).padStart(2, "0")}`

const host = defineCapability({
  id: "compact-under-pressure-host", version: "1",
  tools: [defineTool({
    tool: Lookup, handler: ({ query, limit }) => Effect.succeed(records(query, limit)), annotations: { readOnly: true },
    view: { version: "1", render: (result) => result, compact: (_result, { query, limit }) => compactRecords(query, limit) },
  })],
  skills: [defineSkill({ id: "core", summary: "Look records up.", tools: ["lookup"], always: true })],
})

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, params: { readonly query: string; readonly limit: number }): Part => [{ type: "tool-call", id, name: "lookup", params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]
const encodePrompt = Schema.encodeSync(Prompt.Prompt)

/** A model request as the journey reads it: each message as the bytes sent, and the lookup results in order. */
interface Seen {
  readonly messages: ReadonlyArray<string>
  readonly results: ReadonlyArray<unknown>
}

/** A settled model that serves `script` in order, recording every request it receives. */
const scripted = (seen: Ref.Ref<ReadonlyArray<Seen>>, script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      const prompt = encodePrompt(options.prompt)
      yield* Ref.update(seen, (all) => [...all, {
        messages: prompt.content.map((message) => JSON.stringify(message)),
        results: prompt.content.flatMap((message) => message.role === "tool" ? message.content.flatMap((part) => part.type === "tool-result" ? [part.result] : []) : []),
      }])
      return (script[index] ?? stop("done")) as never
    }),
    streamText: () => Stream.die("not scripted"),
  })
})

const runToStop = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({ limits: { requireCompletion: false } })),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
)

const [alpha, beta, gamma, delta] = [{ query: "alpha", limit: 10 }, { query: "beta", limit: 60 }, { query: "gamma", limit: 20 }, { query: "delta", limit: 2 }]
const turns: ReadonlyArray<{ readonly text: string; readonly model: ReadonlyArray<Part> }> = [
  { text: "find the alpha records", model: [call("t1", alpha), stop("Alpha has ten records.")] },
  { text: "and the beta records?", model: [call("t2", beta), stop("Beta has sixty records.")] },
  // The gamma records pass the budget; the turn then reads on, under it again.
  { text: "compare them with the gamma and delta records", model: [call("t3", gamma), call("t4", delta), stop("Gamma has twenty records, delta two.")] },
]

const decodeBuilt = Schema.decodeUnknownSync(Schema.Struct({ estimatedTokens: Schema.Int, reservedTokens: Schema.Int, budgetTokens: Schema.Int, compactions: Schema.Int, strategyVersion: Schema.String }))

/** The three turns in one fresh session under `budgetTokens`: every request the model saw, each step's `context.built` and the compactions stored. */
const runConversation = (budgetTokens: number, currentTurnFirst = false) => Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: ConversationId.make("00000000-0000-4000-8000-00000c0a9ac7"), owner: "compact-under-pressure-journey" }
  yield* sessions.create({ owner: address.owner, id: address.id })
  const agent = yield* Agent.define({
    // Results are kept under no bound, so only the budget shortens what a request shows.
    plugins: [{ plugin: memoryWindowPlugin, options: { compactPreviousTurn: false, boundOnWriteChars: 0, currentTurnFirst } }, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [host],
    turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, maxSteps: 4 },
    system: "Answer from the records.",
    budgetTokens,
  })
  const seen = yield* Ref.make<ReadonlyArray<Seen>>([])
  const outcomes = yield* Effect.forEach(turns, (scriptedTurn, index) => Effect.gen(function* () {
    const model = yield* scripted(seen, scriptedTurn.model)
    const outcome = yield* agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: scriptedTurn.text }), runId: RunId.make(`run-${index + 1}`) },
      services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
    }, runToStop)
    return outcome.outcome
  }), { concurrency: 1 })
  const stored = yield* sessions.read(address)
  const entries = yield* entriesOfEvents(stored)
  return {
    outcomes,
    requests: yield* Ref.get(seen),
    built: stored.filter((event) => event.kind === "context.built").map((event) => decodeBuilt(event.data)),
    compactions: entries.flatMap((entry) => entry.body._tag === "Compaction" ? [{ turn: entry.turn, strategy: entry.body.strategy, version: entry.body.version, action: entry.body.action }] : []),
    /** The entry id of each lookup result, in the order they were read. */
    results: entries.flatMap((entry) => entry.body._tag === "ToolResult" ? [entry.id] : []),
  }
}))

/** For each request after the first: whether it is the request before it, byte for byte, with more messages after. */
const extendsThePrevious = (requests: ReadonlyArray<Seen>): ReadonlyArray<boolean> => requests.slice(1).map((request, index) => {
  const earlier = requests[index]?.messages ?? []
  return request.messages.length > earlier.length && earlier.every((message, at) => message === request.messages[at])
})

/** The sixth request, the one after the gamma records, is the first that passes this budget: by 254 estimated tokens, which one compact view of the alpha records would not free. */
const BUDGET = 2_200
const whole = { alpha: records(alpha.query, alpha.limit), beta: records(beta.query, beta.limit), gamma: records(gamma.query, gamma.limit), delta: records(delta.query, delta.limit) }
const compactBeta = compactRecords(beta.query, beta.limit)

test.each([
  { order: "the default order", currentTurnFirst: false, version: "4" },
  { order: "currentTurnFirst", currentTurnFirst: true, version: "4+current-turn-first" },
])("over budget with compactPreviousTurn off, the next request shows an earlier result through its compact view and nothing is spilled or dropped ($order)", async ({ currentTurnFirst, version }) => {
  const ran = await Effect.runPromise(runConversation(BUDGET, currentTurnFirst))
  expect(ran.outcomes).toEqual(["completed", "completed", "completed"])
  expect(ran.requests).toHaveLength(7)

  // One compaction in the whole session: the compact view of the beta records, the second of the four results, decided at the step that passed the budget.
  expect(ran.results).toHaveLength(4)
  expect(ran.compactions).toEqual([{ turn: 3, strategy: "window", version, action: { _tag: "CompactViews", entries: ran.results.slice(1, 2), texts: [compactBeta] } }])
  expect(ran.built.map((step) => step.compactions)).toEqual([0, 0, 0, 0, 0, 1, 1])
  expect(ran.built.every((step) => step.budgetTokens === BUDGET && step.estimatedTokens + step.reservedTokens <= BUDGET)).toBe(true)

  // Before the pressure no request rewrites an earlier one: each is the one before it, byte for byte, with more messages after, across both turn starts.
  const [, , , , fifth, sixth, seventh] = ran.requests
  expect(extendsThePrevious(ran.requests.slice(0, 5))).toEqual([true, true, true, true])
  expect(fifth?.results).toEqual([whole.alpha, whole.beta])

  // The request over budget shows the beta records compact. The alpha records, which the budget does not need, and the current turn's gamma records stay whole.
  expect(sixth?.results).toEqual([whole.alpha, compactBeta, whole.gamma])
  // Its messages are the fifth request's up to the beta result, and again after it.
  const changedAt = fifth?.messages.findIndex((message) => message.includes(JSON.stringify(whole.beta).slice(1, -1))) ?? -1
  expect(changedAt).toBeGreaterThan(0)
  expect(sixth?.messages.slice(0, changedAt)).toEqual(fifth?.messages.slice(0, changedAt))
  expect(sixth?.messages[changedAt]).toContain(compactBeta)
  expect(sixth?.messages.slice(changedAt + 1, fifth?.messages.length)).toEqual(fifth?.messages.slice(changedAt + 1))

  // Under the budget again, the next request extends that one unchanged.
  expect(extendsThePrevious(ran.requests.slice(5))).toEqual([true])
  expect(seventh?.results).toEqual([whole.alpha, compactBeta, whole.gamma, whole.delta])
})

test("under budget with compactPreviousTurn off, nothing is recorded and every request extends the one before it", async () => {
  const ran = await Effect.runPromise(runConversation(64_000))
  expect(ran.outcomes).toEqual(["completed", "completed", "completed"])
  expect(ran.compactions).toEqual([])
  expect(ran.built.map((step) => step.compactions)).toEqual([0, 0, 0, 0, 0, 0, 0])
  expect(extendsThePrevious(ran.requests)).toEqual([true, true, true, true, true, true])
  expect(ran.requests.at(-1)?.results).toEqual([whole.alpha, whole.beta, whole.gamma, whole.delta])
})
