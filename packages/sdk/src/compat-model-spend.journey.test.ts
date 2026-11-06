import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  ConversationId,
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
  ToolCallId,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { ModelPrice, SessionAddress } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { modelsPlugin, ModelSpendOptions } from "@xandreed/plugin-models"
import { makeCompatLanguageModel } from "@xandreed/plugin-models/compat"
import { scriptedChatCompletions } from "@xandreed/plugin-models/testing"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * A host that builds the OpenAI-compatible model itself, without the models
 * plugin, guards its spend through `CompatConfig.spend`: whole streamed
 * turns on a scripted endpoint, where each send reserves its worst case in
 * the agent's ModelSpend ledger for the turn and settles at what its
 * reported usage cost, `TurnResult.spend` returns the turn's settled spend,
 * and a send past the turn's cap is never sent and fails the turn with the
 * typed refusal. Input is free and each output token costs 1, so a send's
 * worst case is the model's output cap (100) and its settled cost its
 * completion tokens.
 */

const price: ModelPrice = { input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }
const WORST = 100

const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})
const host = defineCapability({
  id: "compat-spend-host", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed(`FOUND record-${query}`) })],
  skills: [defineSkill({ id: "records", summary: "Look records up.", tools: ["lookup"], always: true })],
})

const answered = (request: { readonly body: Schema.JsonObject }) => JSON.stringify(request.body["messages"] ?? []).includes("FOUND record-alpha")

/**
 * An agent whose model the host built over a scripted endpoint (a tool call
 * costing 9, then an answer costing 3), guarded by one ledger within
 * `turnCap`. With `beside`, the agent also stacks the models plugin with
 * its own `spend` option over a second ledger (`pluginLedger`, the agent's
 * `ModelSpend`), whose prices name only the plugin's own model.
 */
const hostAgent = (turnCap: number, beside = false) => Effect.gen(function* () {
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const ledger = Context.get(yield* Layer.build(ModelSpendMemoryLive), ModelSpend)
  const pluginLedger = Context.get(yield* Layer.build(ModelSpendMemoryLive), ModelSpend)
  const endpoint = scriptedChatCompletions([
    { toolCalls: [{ id: ToolCallId.make("call_lookup"), name: "lookup", arguments: `{"query":"alpha"}` }], usage: { promptTokens: 40, completionTokens: 9 }, when: (request) => !answered(request) },
    { text: "Found alpha.", usage: { promptTokens: 60, completionTokens: 3 }, when: answered },
  ])
  const options = yield* Schema.decodeUnknownEffect(ModelSpendOptions)({ prices: { "Scripted:m": price }, turnCap })
  const model = yield* makeCompatLanguageModel({
    moduleName: "Scripted", chatUrl: "https://scripted.invalid/v1/chat/completions", model: "m", maxOutputTokens: WORST,
    fetchImpl: endpoint.fetch, spend: { ledger, options },
  })
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, ...(beside ? [{ plugin: modelsPlugin, options: {
      storage: "memory" as const, model: "plugin:own", endpoints: { plugin: { url: "https://plugin.invalid/v1" } },
      spend: { prices: { "plugin:own": price }, turnCap: 1 },
    } }] : [])],
    capabilities: [host],
    services: Context.make(ModelSpend, beside ? pluginLedger : ledger),
    turnServices: [LanguageModel.LanguageModel, Sessions],
    limits: { streaming: true, maxSteps: 3 },
  })
  const turn = (session: SessionAddress, runId: RunId) => agent.turn({
    turn: { session, userMessage: new UserMessage({ text: "look alpha up" }), runId },
    services: Context.make(LanguageModel.LanguageModel, model).pipe(Context.add(Sessions, sessions)),
  }, (current) => current.tools.select(current.userMessage).pipe(
    Effect.andThen(current.run({})),
    Effect.flatMap((result) => current.reply(result.text)),
  ))
  return { sessions, ledger, pluginLedger, endpoint, turn }
})

const sessionOf = (id: string): SessionAddress => ({ owner: "compat-spend", id: ConversationId.make(id) })

describe("journey: a host-built compat model's spend guard", () => {
  test("a streamed turn settles each send at its reported usage's cost and returns the turn's spend", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, ledger, endpoint, turn } = yield* hostAgent(2 * WORST)
      const session = sessionOf("00000000-0000-4000-8000-0000000c5e01")
      yield* sessions.create(session)
      const result = yield* turn(session, RunId.make("compat-spend-within-cap"))
      const requests = yield* endpoint.requests
      return { result, streamed: requests.map((request) => request.stream), total: yield* ledger.totals(Option.none()) }
    })))
    expect(observed.result.outcome).toBe("completed")
    expect(observed.streamed).toEqual([true, true])
    expect(observed.result.spend).toEqual({ settled: 12, reserved: 0 })
    expect(observed.total).toEqual({ settled: 12, reserved: 0 })
  })

  test("a send whose worst case passes the turn's cap is never sent and fails the turn with model.spend", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { sessions, ledger, endpoint, turn } = yield* hostAgent(WORST + 8)
      const session = sessionOf("00000000-0000-4000-8000-0000000c5e02")
      yield* sessions.create(session)
      const error = yield* Effect.flip(turn(session, RunId.make("compat-spend-past-cap")))
      return { error, sends: (yield* endpoint.requests).length, total: yield* ledger.totals(Option.none()) }
    })))
    expect(harnessCodeOf(observed.error)).toEqual(Option.some("model.spend"))
    expect(Option.map(modelSpendExceededOf(observed.error), (refusal) => [refusal.reason, refusal.cap, refusal.committed, refusal.requested])).toEqual(Option.some(["turn", WORST + 8, 9, WORST]))
    expect(observed.sends).toBe(1)
    expect(observed.total).toEqual({ settled: 9, reserved: 0 })
  })

  test("beside the models plugin's own spend option, the host's model reserves and settles only in its own guard", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      // The plugin's guard prices only its own model and caps a turn at 1: had it guarded the host's sends, the turn would fail.
      const { sessions, ledger, pluginLedger, endpoint, turn } = yield* hostAgent(2 * WORST, true)
      const session = sessionOf("00000000-0000-4000-8000-0000000c5e03")
      yield* sessions.create(session)
      const result = yield* turn(session, RunId.make("compat-spend-beside-plugin"))
      return { result, sends: (yield* endpoint.requests).length, own: yield* ledger.totals(Option.none()), plugin: yield* pluginLedger.totals(Option.none()) }
    })))
    expect(observed.result.outcome).toBe("completed")
    expect(observed.sends).toBe(2)
    expect(observed.own).toEqual({ settled: 12, reserved: 0 })
    expect(observed.plugin).toEqual({ settled: 0, reserved: 0 })
  })
})
