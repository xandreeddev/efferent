import { describe, expect, test } from "bun:test"
import { LanguageModel, Tool } from "effect/ai"
import type { Response } from "effect/ai"
import { Context, Effect, Layer, Match, Option, Schema, Stream } from "effect"
import {
  ConversationId,
  defineCapability,
  defineSkill,
  defineTool,
  Failure,
  readStored,
  RunId,
  SessionLogMemoryLive,
  Sessions,
  storedRecordOf,
  TurnAdmissionOpen,
  UserMessage,
} from "@xandreed/core"
import type { StoredKind, StoredRecord } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memoryWindowPlugin } from "@xandreed/plugin-memory-window"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent } from "./agent.adapter.js"

/*
 * A host that shows a conversation projects its journal one record at a
 * time: each stored record is decoded by its own kind (`storedRecordOf`)
 * into the item it shows, without the whole history and without a copy of
 * the framework's stored shapes. This journey writes a tool call that
 * completes, one the registry refuses and a reply through the real
 * registry, loop, memory and sessions, then projects what was stored.
 */

const Probe = Tool.make("record_probe", {
  description: "Return the number it was given.",
  parameters: Schema.Struct({ n: Schema.Number }),
  success: Schema.Number,
  failure: Failure,
  failureMode: "return",
})
const usage = { inputTokens: { total: 2 }, outputTokens: { total: 1 } }
const script: ReadonlyArray<ReadonlyArray<Response.PartEncoded>> = [
  [
    { type: "text", text: "Checking both." },
    { type: "tool-call", id: "call-1", name: Probe.name, params: { n: 1 }, providerExecuted: false },
    { type: "tool-call", id: "call-2", name: Probe.name, params: { n: 2 }, providerExecuted: false },
    { type: "finish", reason: "tool-calls", usage },
  ],
  [{ type: "text", text: "One answered." }, { type: "finish", reason: "stop", usage }],
]

/** What a conversation view shows for one record, or nothing. */
const itemOf = Match.type<StoredRecord>().pipe(
  Match.discriminators("kind")({
    "turn.started": (record) => [`user: ${record.data.userMessage.text}`],
    "memory.message": (record) => record.data.body.message.role === "assistant"
      ? record.data.body.message.content.flatMap((part) => Match.value(part).pipe(
        Match.discriminators("type")({
          text: (text) => [`assistant: ${text.text}`],
          "tool-call": (call) => [`call ${call.toolCallId} ${call.toolName}`],
        }),
        Match.orElse((): ReadonlyArray<string> => []),
      ))
      : [],
    "tool.started": (record) => [`started ${Option.getOrElse(Option.fromNullishOr(record.data.toolCallId), () => "?")} ${record.data.tool}`],
    "tool.completed": (record) => [`completed ${Option.getOrElse(Option.fromNullishOr(record.data.toolCallId), () => "?")} ok=${record.data.ok}`],
    "tool.refused": (record) => [`refused ${Option.getOrElse(Option.fromNullishOr(record.data.toolCallId), () => "?")} ${record.data.reason}`],
    "turn.ended": (record) => [`ended ${record.data.reason}`],
  }),
  Match.orElse((): ReadonlyArray<string> => []),
)

describe("journey: stored records projected one at a time", () => {
  test("a completed call, a refused call and the reply read back typed, record by record, as the whole-history readers read them", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const services = yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen))))
      const sessions = Context.get(services, Sessions)
      const address = { owner: "stored-records-journey", id: ConversationId.make("00000000-0000-4000-8000-000000005520") }
      yield* sessions.create(address)
      const replies = [...script]
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([...(replies.shift() ?? script[1]!)]),
        streamText: () => Stream.die("not scripted"),
      })
      const agent = yield* Agent.define({
        plugins: [memoryWindowPlugin, { plugin: toolDiscoveryPlugin, options: { toolPolicy: { [Probe.name]: { maxCallsPerRun: 1 } } } }, stepLoopPlugin],
        capabilities: [defineCapability({
          id: "stored-records-journey", version: "1",
          tools: [defineTool({ tool: Probe, handler: ({ n }) => Effect.succeed(n), annotations: { readOnly: true } })],
          skills: [defineSkill({ id: "stored-records", summary: "Return numbers.", tools: [Probe.name], always: true })],
        })],
        turnServices: [LanguageModel.LanguageModel],
        limits: { streaming: false, maxSteps: 3, toolConcurrency: 1 },
      })
      yield* agent.turn({
        turn: { session: address, userMessage: new UserMessage({ text: "probe twice" }), runId: RunId.make("stored-records") },
        services: Context.merge(Context.make(Sessions, sessions), Context.make(LanguageModel.LanguageModel, model)),
      }, (turn) => turn.tools.select(turn.userMessage).pipe(
        Effect.andThen(turn.run({})),
        Effect.map((done) => ({ outcome: done.outcome, reply: Option.some(done.text) })),
      ))
      const events = yield* sessions.read(address)
      const records = (yield* Effect.forEach(events, storedRecordOf, { concurrency: 1 })).flatMap(Option.toArray)
      const kinds: ReadonlyArray<StoredKind> = ["tool.started", "tool.completed", "tool.refused", "memory.message", "turn.started", "turn.ended"]
      const whole = yield* Effect.forEach(kinds, (kind) => readStored(kind, events).pipe(Effect.map((read) => read.map((stored) => [stored.event.seq, stored.data] as const))), { concurrency: 1 })
      return { records, whole, kinds }
    })))

    expect(observed.records.flatMap(itemOf)).toEqual([
      "user: probe twice",
      "assistant: Checking both.",
      "call call-1 record_probe",
      "call call-2 record_probe",
      "started call-1 record_probe",
      "completed call-1 ok=true",
      "refused call-2 run-call-limit",
      "assistant: One answered.",
      "ended completed",
    ])
    // The record-by-record decode is the whole-history reader's, kind by kind.
    expect(observed.kinds.map((kind) => observed.records.filter((record) => record.kind === kind).map((record) => [record.event.seq, record.data] as const))).toEqual(observed.whole)
    // A completed call's stored record holds no input and no result: memory keeps them.
    const completed = observed.records.find((record) => record.kind === "tool.completed")
    expect(completed === undefined ? [] : Object.keys(completed.data).toSorted()).toEqual(["durationMs", "invocationId", "labels", "ok", "stage", "step", "tool", "toolCallId"])
  })
})
