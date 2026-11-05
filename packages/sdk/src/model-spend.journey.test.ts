import { afterAll, describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  ConversationId,
  costOf,
  defineCapability,
  defineSkill,
  defineTool,
  Failure,
  harnessCodeOf,
  ModelSpend,
  ModelSpendMemoryLive,
  modelSpendExceededOf,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  TurnAdmissionOpen,
  turnModelCallsOf,
  UserMessage,
} from "@xandreed/core"
import type { ModelPrice, SessionAddress } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { modelsPlugin } from "@xandreed/plugin-models"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * The models plugin's spend guard through whole turns on an
 * OpenAI-compatible endpoint. Each physical send reserves its worst case in
 * the agent's ModelSpend ledger and settles at what its reported usage cost;
 * a send that would pass the turn's or the ledger's cap is refused before
 * it goes out, and the turn fails with the typed refusal. Input is free and
 * each output token costs 1, so a send's worst case is its output cap (100,
 * as none is sent) and its settled cost is its completion tokens.
 */

const price: ModelPrice = { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }
const WORST = 100

const Lookup = Tool.make("lookup", {
  description: "Look a record up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const host = defineCapability({
  id: "model-spend-host", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed(`FOUND record-${query}`) })],
  skills: [defineSkill({ id: "records", summary: "Look records up.", tools: ["lookup"], always: true })],
})

/** A chat-completions endpoint: a tool call (5 completion tokens) to a request without a tool result, else the answer (2). */
const endpoint = () => {
  const requests: Array<unknown> = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const body: unknown = await request.json()
      requests.push(body)
      const answered = JSON.stringify(body).includes("FOUND")
      return Response.json(answered
        ? { id: "answer", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: "Found it." }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 2, total_tokens: 32 } }
        : { id: "call", object: "chat.completion", model: "m", choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: `{"query":"alpha"}` } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })
    },
  })
  return { requests, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}
const server = endpoint()
afterAll(() => server.stop())

const sessionsLayer = SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))

/** An agent on the endpoint with the spend option, over one ledger shared by its turns. */
const spendingAgent = (caps: { readonly turnCap?: number; readonly totalCap?: number }) => Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(sessionsLayer), Sessions)
  const ledger = Context.get(yield* Layer.build(ModelSpendMemoryLive), ModelSpend)
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
      storage: "memory", model: "stub:m", endpoints: { stub: { url: server.url } },
      spend: { prices: { "stub:m": price }, uncappedOutputTokens: WORST, ...caps },
    } }],
    capabilities: [host],
    services: Context.make(ModelSpend, ledger),
    limits: { streaming: false, maxSteps: 4 },
  })
  const turn = (session: SessionAddress, runId: RunId) => agent.turn({
    turn: { session, userMessage: new UserMessage({ text: "look alpha up" }), runId },
    services: Context.make(Sessions, sessions),
  }, (current) => current.tools.select(current.userMessage).pipe(
    Effect.andThen(current.run({})),
    Effect.flatMap((result) => current.reply(result.text)),
  ))
  /** What the turn's recorded model calls cost at the price, from their stored usage. */
  const recordedCost = (session: SessionAddress, number: number) => Effect.gen(function* () {
    const calls = yield* turnModelCallsOf(yield* sessions.read(session), number)
    return { calls: calls.length, cost: calls.reduce((sum, call) => sum + (call.usage._tag === "Known" ? costOf(call.usage.usage, price) : Number.NaN), 0) }
  })
  return { sessions, ledger, turn, recordedCost }
})

const sessionOf = (id: string): SessionAddress => ({ owner: "model-spend", id: ConversationId.make(id) })

describe("journey: the models plugin's spend guard", () => {
  test("a turn under its cap settles what its sends cost, as the recorded usage prices it, and returns it; the ledger forgets the ended turn, its total keeping the spend", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, ledger, turn, recordedCost } = yield* spendingAgent({ turnCap: WORST + 5 })
      const session = sessionOf("00000000-0000-4000-8000-00000000a501")
      yield* sessions.create(session)
      const runId = RunId.make("spend-within-cap")
      const result = yield* turn(session, runId)
      return { result, ledger: yield* ledger.totals(Option.some(runId)), total: yield* ledger.totals(Option.none()), recorded: yield* recordedCost(session, 1) }
    })))
    expect(observed.result.outcome).toBe("completed")
    expect(observed.recorded).toEqual({ calls: 2, cost: 7 })
    expect(observed.result.spend).toEqual({ settled: 7, reserved: 0 })
    expect(observed.ledger).toEqual({ settled: 0, reserved: 0 })
    expect(observed.total).toEqual({ settled: 7, reserved: 0 })
  })

  test("a turn whose next send would pass its cap stops with the typed refusal before the send goes out", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, ledger, turn, recordedCost } = yield* spendingAgent({ turnCap: WORST + 4 })
      const session = sessionOf("00000000-0000-4000-8000-00000000a502")
      yield* sessions.create(session)
      const runId = RunId.make("spend-past-turn-cap")
      const sent = server.requests.length
      const error = yield* Effect.flip(turn(session, runId))
      const stored = yield* sessions.read(session)
      return { error, sends: server.requests.length - sent, ledger: yield* ledger.totals(Option.some(runId)), total: yield* ledger.totals(Option.none()), recorded: yield* recordedCost(session, 1), ended: stored.filter((event) => event.kind === "turn.ended").map((event) => event.data) }
    })))
    expect(harnessCodeOf(observed.error)).toEqual(Option.some("model.spend"))
    expect(Option.map(modelSpendExceededOf(observed.error), (refusal) => [refusal.reason, refusal.cap, refusal.committed, refusal.requested])).toEqual(Option.some(["turn", WORST + 4, 5, WORST]))
    // The first send went out and settled; the second was refused before it was sent.
    expect(observed.sends).toBe(1)
    expect(observed.recorded).toEqual({ calls: 1, cost: 5 })
    // A failed turn is forgotten too: the ledger's total keeps what it settled.
    expect(observed.ledger).toEqual({ settled: 0, reserved: 0 })
    expect(observed.total).toEqual({ settled: 5, reserved: 0 })
    expect(observed.ended).toMatchObject([{ reason: "failed", failure: { code: "model.spend" } }])
  })

  test("the ledger's total cap stops a later turn once the turns before it have spent their share", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, ledger, turn } = yield* spendingAgent({ totalCap: WORST + 10 })
      const first = sessionOf("00000000-0000-4000-8000-00000000a503")
      const second = sessionOf("00000000-0000-4000-8000-00000000a504")
      yield* sessions.create(first)
      yield* sessions.create(second)
      const done = yield* turn(first, RunId.make("spend-total-first"))
      const error = yield* Effect.flip(turn(second, RunId.make("spend-total-second")))
      return { done, error, total: yield* ledger.totals(Option.none()), second: yield* ledger.totals(Option.some(RunId.make("spend-total-second"))) }
    })))
    expect(observed.done.spend).toEqual({ settled: 7, reserved: 0 })
    expect(Option.map(modelSpendExceededOf(observed.error), (refusal) => [refusal.reason, refusal.committed])).toEqual(Option.some(["total", 12]))
    expect(observed.second).toEqual({ settled: 0, reserved: 0 })
    expect(observed.total).toEqual({ settled: 12, reserved: 0 })
  })

  test("the spend option without a ledger among the agent's services is refused when the agent is defined", async () => {
    const error = await Effect.runPromise(Effect.scoped(Effect.flip(Agent.define({
      plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: {
        storage: "memory", model: "stub:m", endpoints: { stub: { url: server.url } }, spend: { prices: { "stub:m": price }, turnCap: 1 },
      } }],
      turnServices: [Sessions],
    }))))
    expect(harnessCodeOf(error)).toEqual(Option.some("config.options"))
    expect(error.message).toContain("needs a ModelSpend ledger")
  })
})
