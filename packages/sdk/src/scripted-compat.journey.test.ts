import { describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import {
  ConversationId,
  defineCapability,
  defineSkill,
  defineTool,
  Failure,
  onEvent,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  subscribeAll,
  ToolCallId,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { TurnEventOf, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { modelsPlugin, ModelsTransport } from "@xandreed/plugin-models"
import { scriptedChatCompletions } from "@xandreed/plugin-models/testing"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * A keyless turn on the production models plugin and its OpenAI-compatible
 * client: the host gives the plugin a scripted endpoint as its
 * ModelsTransport, so only the transport is fake. The endpoint streams a
 * tool call's arguments in fragments with its usage on the final chunk,
 * then, once the tool's result is in the request, the answer, with no usage.
 * The bus carries the fragments, the tool runs on the arguments they make,
 * the recorder keeps the reported usage as known and the missing one as
 * unknown, and the endpoint has seen both requests, each answered by its step.
 */

const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

const host = defineCapability({
  id: "scripted-compat-host", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed(`FOUND record-${query}`) })],
  skills: [defineSkill({ id: "records", summary: "Look records up.", tools: ["lookup"], always: true })],
})

const answered = (request: { readonly body: Schema.JsonObject }) => JSON.stringify(request.body["messages"] ?? []).includes("FOUND record-alpha")

type Delta = TurnEventOf<"assistant.delta">
type Called = TurnEventOf<"model.called">

const journey = Effect.gen(function* () {
  const endpoint = scriptedChatCompletions([
    {
      toolCalls: [{ id: ToolCallId.make("call_lookup"), name: "lookup", arguments: `{"query":"alpha"}` }],
      usage: { promptTokens: 40, completionTokens: 9, cachedTokens: 16 },
      chunkSize: 6,
      when: (request) => !answered(request),
    },
    { text: "Found alpha.", when: answered },
  ])
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { owner: "scripted-compat", id: ConversationId.make("00000000-0000-4000-8000-0000005c0a7e") }
  yield* sessions.create(address)
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: { storage: "memory", model: "scripted:m", endpoints: { scripted: { url: "https://scripted.invalid/v1" } } } }],
    capabilities: [host],
    services: Context.make(ModelsTransport, ModelsTransport.of({ fetch: endpoint.fetch })),
    limits: { streaming: true, maxSteps: 3 },
  })
  const deltas = yield* Ref.make<ReadonlyArray<Delta>>([])
  const calls = yield* Ref.make<ReadonlyArray<Called>>([])
  const outcome = yield* agent.turn({
    turn: { session: address, userMessage: new UserMessage({ text: "look alpha up" }), runId: RunId.make("scripted-compat-run") },
    services: Context.make(Sessions, sessions),
  }, (turn) => subscribeAll(turn.events, [
    onEvent("assistant.delta", (event) => Ref.update(deltas, (all) => [...all, event])),
    onEvent("model.called", (event) => Ref.update(calls, (all) => [...all, event])),
  ]).pipe(
    Effect.andThen(turn.tools.select(turn.userMessage)),
    Effect.andThen(turn.run({})),
    Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
  ))
  return {
    outcome,
    deltas: yield* Ref.get(deltas),
    calls: yield* Ref.get(calls),
    requests: yield* endpoint.requests,
    remaining: yield* endpoint.remaining,
  }
})

describe("journey: a keyless turn on the models plugin over a scripted OpenAI-compatible endpoint", () => {
  test("the tool call's argument fragments reach the bus, the tool runs, usage is known where reported and unknown where not, and each request took its step", async () => {
    const observed = await Effect.runPromise(Effect.scoped(journey))
    expect(observed.outcome).toMatchObject({ outcome: "completed", reply: Option.some("Found alpha.") })
    // The fragments the endpoint sent, six characters each, on the tool-params channel.
    expect(observed.deltas.filter((delta) => delta.channel === "tool-params" && delta.delta.length > 0).map((delta) => [String(delta.id), delta.delta]))
      .toEqual([["call_lookup", `{"quer`], ["call_lookup", `y":"al`], ["call_lookup", `pha"}`]])
    // Both requests streamed to the configured endpoint; the second carried the tool's result.
    expect(observed.requests.map((request) => [request.url, request.stream, request.body["model"], request.step]))
      .toEqual([["https://scripted.invalid/v1/chat/completions", true, "m", Option.some(0)], ["https://scripted.invalid/v1/chat/completions", true, "m", Option.some(1)]])
    expect(JSON.stringify(observed.requests[0]?.body["tools"])).toContain(`"name":"lookup"`)
    expect(answered(observed.requests[1]!)).toBe(true)
    expect(observed.remaining).toEqual([])
    // The first reply reported its usage on its final chunk; the answer reported none, which stays unknown.
    expect(observed.calls.map((call) => call.usage._tag)).toEqual(["Known", "Unknown"])
    expect(observed.calls[0]?.usage).toMatchObject({ usage: { inputTokens: 40, outputTokens: 9, cacheReadTokens: 16 } })
  })
})
