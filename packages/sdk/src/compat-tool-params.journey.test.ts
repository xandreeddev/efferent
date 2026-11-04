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
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { TurnEventOf, TurnOutcome } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { modelsPlugin } from "@xandreed/plugin-models"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * A streamed turn on an OpenAI-compatible endpoint: the endpoint sends a
 * reply's tool calls with their arguments in fragments, and the turn's bus
 * carries them as they arrive, on assistant.delta's `tool-params` channel.
 * Each call's deltas, concatenated, are the input its assistant.message
 * carries. The endpoint holds the rest of its reply until the first argument
 * delta has reached the bus, so a client that buffered the calls to the end
 * of the stream would be seen to.
 */

const Lookup = Tool.make("lookup", {
  description: "Look records up by query.",
  parameters: Schema.Struct({ query: Schema.String, limit: Schema.Number }),
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

const host = defineCapability({
  id: "compat-tool-params-host", version: "1",
  tools: [defineTool({ tool: Lookup, handler: ({ query }) => Effect.succeed(`FOUND record-${query}`) })],
  skills: [defineSkill({ id: "records", summary: "Look records up.", tools: ["lookup"], always: true })],
})

const sse = (chunks: ReadonlyArray<unknown>): string => chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
const fragment = (index: number, fields: Readonly<Record<string, unknown>>) => ({ choices: [{ delta: { tool_calls: [{ index, ...fields }] } }] })

/** The first reply: a call with the provider's id and one without, arguments in pieces; the rest waits for `release`. */
const head = [
  fragment(0, { id: "call_provider", type: "function", function: { name: "lookup", arguments: "" } }),
  fragment(0, { function: { arguments: `{"query":` } }),
]
const tail = [
  fragment(0, { function: { arguments: `"alpha","limit":` } }),
  fragment(1, { function: { name: "lookup", arguments: `{"query":"beta",` } }),
  fragment(0, { function: { arguments: "3}" } }),
  fragment(1, { function: { arguments: `"limit":1}` } }),
  { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
]
const answer = [
  { choices: [{ delta: { content: "Found both." }, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 } },
]

const enc = new TextEncoder()

/** A chat-completions endpoint that streams `head`, waits for `release` (or gives up after `holdMs`), then streams the rest. */
const endpoint = (release: Promise<void>, holdMs: number) => {
  const held: Array<boolean> = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: async (request) => {
      const body = await request.json() as { readonly messages?: ReadonlyArray<unknown> }
      const first = (body.messages ?? []).every((message) => !JSON.stringify(message).includes("FOUND"))
      return new Response(new ReadableStream({
        async start(controller) {
          if (!first) {
            controller.enqueue(enc.encode(`${sse(answer)}data: [DONE]\n\n`))
            return controller.close()
          }
          controller.enqueue(enc.encode(sse(head)))
          held.push(await Promise.race([release.then(() => true), Bun.sleep(holdMs).then(() => false)]))
          controller.enqueue(enc.encode(`${sse(tail)}data: [DONE]\n\n`))
          controller.close()
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } })
    },
  })
  return { held, url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) }
}

type Delta = TurnEventOf<"assistant.delta">
type Message = TurnEventOf<"assistant.message">

const journey = Effect.gen(function* () {
  const released = Promise.withResolvers<void>()
  const server = endpoint(released.promise, 2_000)
  yield* Effect.addFinalizer(() => Effect.sync(server.stop))
  const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
  const address = { owner: "compat-tool-params", id: ConversationId.make("00000000-0000-4000-8000-00000000c0a7") }
  yield* sessions.create(address)
  const agent = yield* Agent.define({
    plugins: [memoryWindowPlugin, toolDiscoveryPlugin, stepLoopPlugin, { plugin: modelsPlugin, options: { storage: "memory", model: "stub:m", endpoints: { stub: { url: server.url } } } }],
    capabilities: [host],
    limits: { streaming: true, maxSteps: 3 },
  })
  const deltas = yield* Ref.make<ReadonlyArray<Delta>>([])
  const messages = yield* Ref.make<ReadonlyArray<Message>>([])
  const outcome = yield* agent.turn({
    turn: { session: address, userMessage: new UserMessage({ text: "look alpha and beta up" }), runId: RunId.make("compat-tool-params-run") },
    services: Context.make(Sessions, sessions),
  }, (turn) => subscribeAll(turn.events, [
    onEvent("assistant.delta", (event) => Ref.update(deltas, (all) => [...all, event]).pipe(
      Effect.tap(() => event.channel === "tool-params" && event.delta.length > 0 ? Effect.sync(() => released.resolve()) : Effect.void))),
    onEvent("assistant.message", (event) => Ref.update(messages, (all) => [...all, event])),
  ]).pipe(
    Effect.andThen(turn.tools.select(turn.userMessage)),
    Effect.andThen(turn.run({})),
    Effect.map((result): TurnOutcome => ({ outcome: result.outcome, reply: Option.some(result.text) })),
  ))
  return { outcome, held: server.held, deltas: yield* Ref.get(deltas), messages: yield* Ref.get(messages) }
})

describe("journey: an OpenAI-compatible endpoint's tool-call arguments stream on the bus", () => {
  test("each call's tool-params deltas arrive while the reply streams and concatenate to the input its assistant.message carries", async () => {
    const observed = await Effect.runPromise(Effect.scoped(journey))
    expect(observed.outcome).toMatchObject({ outcome: "completed", reply: Option.some("Found both.") })
    // The endpoint sent its tail only after the first argument delta reached the bus.
    expect(observed.held).toEqual([true])
    const params = observed.deltas.filter((delta) => delta.channel === "tool-params" && delta.step === 0)
    const ids = [...new Set(params.map((delta) => String(delta.id)))]
    // The provider's id for the first call; the id-less second call streams under its wire index.
    expect(ids).toEqual(["call_provider", "call-1"])
    const streamedOf = (id: string) => params.filter((delta) => delta.id === id).map((delta) => delta.delta)
    // Each part opens with an empty delta (its start), then one delta per arguments fragment.
    expect(streamedOf("call_provider")).toEqual(["", `{"query":`, `"alpha","limit":`, "3}"])
    expect(streamedOf("call-1")).toEqual(["", `{"query":"beta",`, `"limit":1}`])
    const calls = observed.messages.find((message) => message.step === 0)?.toolCalls ?? []
    expect(calls.map((call) => call.tool)).toEqual(["lookup", "lookup"])
    expect(calls.map((call) => call.input)).toEqual(ids.map((id) => JSON.parse(streamedOf(id).join(""))))
    // A provider id is the call's id; an id-less call keeps the id the loop mints for it.
    expect(String(calls[0]?.id)).toBe("call_provider")
    expect(String(calls[1]?.id)).not.toBe("call-1")
    expect(String(calls[1]?.id).length).toBeGreaterThan(0)
  })
})
