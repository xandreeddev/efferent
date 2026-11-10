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
 * A large result read in the current turn, then used over several steps under
 * a budget that cannot also hold the earlier turn whole. The default window
 * spills the large result at the next step, so the model sees a preview; with
 * `currentTurnFirst` the window drops the earlier turn for a ledger instead,
 * and every later step of the turn sends the result whole. A third turn whose
 * own result does not fit alone is spilled under either order.
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

const host = defineCapability({
  id: "current-turn-host", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query, limit }) => Effect.succeed(records(query, limit)), annotations: { readOnly: true } })],
  skills: [defineSkill({ id: "core", summary: "Look records up.", tools: ["lookup"], always: true })],
})

const usage = { inputTokens: { total: 100 }, outputTokens: { total: 10 } }
type Part = ReadonlyArray<unknown>
const call = (id: string, params: { readonly query: string; readonly limit: number }): Part => [{ type: "tool-call", id, name: "lookup", params }, { type: "finish", reason: "tool-calls", usage }]
const stop = (text: string): Part => [{ type: "text", text }, { type: "finish", reason: "stop", usage }]
const encodePrompt = Schema.encodeSync(Prompt.Prompt)

/** A settled model that serves `script` in order, recording the text of every request it receives. */
const scripted = (requests: Ref.Ref<ReadonlyArray<{ readonly runId: string; readonly text: string }>>, runId: string, script: ReadonlyArray<Part>) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      yield* Ref.update(requests, (all) => [...all, { runId, text: JSON.stringify(encodePrompt(options.prompt)) }])
      return (script[index] ?? stop("done")) as never
    }),
    streamText: () => Stream.die("not scripted"),
  })
})

const runToStop = (turn: Turn) => turn.tools.select(turn.userMessage).pipe(
  Effect.andThen(turn.run({ limits: { requireCompletion: false } })),
  Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
)

/** The large result the second turn reads at its first step and uses at the next two. */
const large = records("beta", 40)
const turns: ReadonlyArray<{ readonly text: string; readonly model: ReadonlyArray<Part> }> = [
  { text: "find the alpha records", model: [call("t1", { query: "alpha", limit: 20 }), stop("Alpha has twenty records.")] },
  { text: "compare the beta and gamma records", model: [call("t2", { query: "beta", limit: 40 }), call("t3", { query: "gamma", limit: 2 }), stop("Beta has forty records, gamma two.")] },
  { text: "and every delta record?", model: [call("t4", { query: "delta", limit: 120 }), stop("Delta has one hundred and twenty records.")] },
]

const runConversation = (currentTurnFirst: boolean) => Effect.scoped(Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { id: ConversationId.make("00000000-0000-4000-8000-00000c0e7f15"), owner: "current-turn-journey" }
  yield* sessions.create({ owner: address.owner, id: address.id })
  const agent = yield* Agent.define({
    plugins: [{ plugin: memoryWindowPlugin, options: { spillMinChars: 1_500, previewChars: 120, ledgerTurnChars: 40, currentTurnFirst } }, toolDiscoveryPlugin, stepLoopPlugin],
    capabilities: [host],
    turnServices: [LanguageModel.LanguageModel],
    limits: { streaming: false, maxSteps: 4 },
    system: "Answer from the records.",
    // The 1,500 tokens the scenario was written for, plus the 67 the schema of `recall_context` has reserved since its description grew (173 then, 240 now): the messages get what they had.
    budgetTokens: 1_567,
  })
  const requests = yield* Ref.make<ReadonlyArray<{ readonly runId: string; readonly text: string }>>([])
  const outcomes = yield* Effect.forEach(turns, (scriptedTurn, index) => Effect.gen(function* () {
    const runId = `run-${index + 1}`
    const model = yield* scripted(requests, runId, scriptedTurn.model)
    const outcome = yield* agent.turn({
      turn: { session: address, userMessage: new UserMessage({ text: scriptedTurn.text }), runId: RunId.make(runId) },
      services: Context.merge(Context.make(LanguageModel.LanguageModel, model), Context.make(Sessions, sessions)),
    }, runToStop)
    return outcome.outcome
  }), { concurrency: 1 })
  const stored = yield* sessions.read(address)
  const entries = yield* entriesOfEvents(stored)
  return {
    outcomes,
    requests: yield* Ref.get(requests),
    actions: entries.flatMap((entry) => entry.body._tag === "Compaction" ? [{ turn: entry.turn, version: entry.body.version, ...entry.body.action }] : []),
    versions: [...new Set(stored.filter((event) => event.kind === "context.built").map((event) => Schema.decodeUnknownSync(Schema.Struct({ strategyVersion: Schema.String }))(event.data).strategyVersion))],
  }
}))

/** Whether each request of `runId` sends the large result whole. */
const sendsWhole = (requests: ReadonlyArray<{ readonly runId: string; readonly text: string }>, runId: string) =>
  requests.filter((request) => request.runId === runId).map((request) => request.text.includes(JSON.stringify(large).slice(1, -1)))

test("the default window spills the current turn's large result while it keeps the earlier turn", async () => {
  const { outcomes, requests, actions, versions } = await Effect.runPromise(runConversation(false))
  expect(outcomes).toEqual(["completed", "completed", "completed"])
  expect(versions).toEqual(["3"])
  expect(actions.filter((action) => action.turn === 2)).toMatchObject([{ _tag: "Spill", entry: "run-2:2", version: "3" }])
  // No step after the one that read it sends the result whole: the model sees a preview and a locator.
  expect(sendsWhole(requests, "run-2")).toEqual([false, false, false])
})

test("currentTurnFirst drops the earlier turn and keeps the current turn's large result whole at every step", async () => {
  const { outcomes, requests, actions, versions } = await Effect.runPromise(runConversation(true))
  expect(outcomes).toEqual(["completed", "completed", "completed"])
  expect(versions).toEqual(["3+current-turn-first"])
  const second = actions.filter((action) => action.turn === 2)
  expect(second).toMatchObject([{ _tag: "DropTurns", throughTurn: 1, version: "3+current-turn-first" }])
  expect(sendsWhole(requests, "run-2")).toEqual([false, true, true])
  // A current turn that does not fit even alone is spilled, and the earlier turns the budget cannot hold are dropped.
  expect(actions.filter((action) => action.turn === 3)).toMatchObject([{ _tag: "Spill", entry: "run-3:2" }, { _tag: "DropTurns", throughTurn: 2 }])
})
