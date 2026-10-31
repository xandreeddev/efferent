import { expect, test } from "bun:test"
import { LanguageModel } from "effect/ai"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import {
  ConversationId, ConversationMemory, CurrentAgentRun, CurrentAgentStep, definePlugin, ENGINE_KEY,
  ModelCallId, ModelId, ModelSelection, openLogSession, ProviderId, recordCompletion,
  RunContext, RunId, RunOrdinal, SessionLogMemoryLive, Sessions, tokenUsage, TurnAdmissionOpen,
  turnBilledUsageOf, turnModelCallsOf, turnUsageOf, UserMessage,
} from "@xandreed/core"
import type { MemoryPolicy, ModelCallPurpose, ModelChoice } from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { Agent } from "./agent.adapter.js"

const model = new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("actual") })
const usage = tokenUsage({ inputTokens: 10, outputTokens: 2 })
const completion = (name: string, purpose: ModelCallPurpose) => Effect.gen(function* () {
  const run = yield* CurrentAgentRun
  const step = yield* CurrentAgentStep
  yield* recordCompletion({
    callId: ModelCallId.make(`${name}:${Option.match(run, { onNone: () => "outside", onSome: (run) => run.ordinal })}`),
    attempt: 1, purpose, method: "Text", model: Option.some(model),
    runId: Option.map(run, (run) => run.id), run: Option.map(run, (run) => run.ordinal),
    step: Option.isSome(run) ? step : Option.none(), durationMs: 1,
    usage: { _tag: "Known", usage }, outcome: { _tag: "Completed" },
  })
})
const memoryPolicy: MemoryPolicy = {
  strategy: { id: "fixture", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.none(),
  maintain: ({ signal }) => (signal.phase === "step" ? completion("maintenance", "Helper").pipe(Effect.orDie) : Effect.void).pipe(Effect.as({ actions: [], digest: [] })),
}
const bootstrapMemory = definePlugin({
  id: "fixture/model-call-memory", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {},
  provides: [ConversationMemory],
  layer: () => Layer.succeed(ConversationMemory, ConversationMemory.of({
    strategy: memoryPolicy.strategy,
    open: (input) => completion("bootstrap", "Helper").pipe(Effect.andThen(openLogSession(input.log, memoryPolicy, { runId: input.runId }))),
  })),
})
const closingHelper = definePlugin({
  id: "fixture/model-call-finalizer", version: "1", scope: "session", config: Schema.Struct({}), defaults: {},
  requires: [RunContext], provides: [],
  layer: () => Layer.effectDiscard(Effect.addFinalizer(() => completion("closing", "Helper").pipe(Effect.orDie))),
})

test("journey: bootstrap and late helpers persist while two runs retain exact correlation and selected usage", async () => {
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    const session = { owner: "fixture", id: ConversationId.make("00000000-0000-4000-8000-000000000018") }
    yield* sessions.create(session)
    const agent = yield* Agent.define({
      plugins: [bootstrapMemory, toolDiscoveryPlugin, stepLoopPlugin, closingHelper],
      turnServices: [LanguageModel.LanguageModel, Sessions], limits: { streaming: false, maxSteps: 1 },
    })
    const scripted = yield* LanguageModel.make({
      generateText: () => completion("loop", "Loop").pipe(Effect.orDie, Effect.as([
        { type: "text", text: "finished" },
        { type: "finish", reason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } }, metadata: { [ENGINE_KEY]: { model: "fixture:actual" } } },
      ])),
      streamText: () => Stream.die("not scripted"),
    })
    const result = yield* agent.turn({
      turn: { session, runId: RunId.make("billing-runs"), userMessage: new UserMessage({ text: "hello" }) },
      services: Context.make(LanguageModel.LanguageModel, scripted).pipe(Context.add(Sessions, sessions)),
    }, (turn) => Effect.gen(function* () {
      const policy = { model: () => completion("policy", "Helper").pipe(Effect.orDie, Effect.as(Option.none<ModelChoice>())) }
      yield* turn.run(policy)
      yield* turn.run(policy)
      return yield* turn.reply("finished")
    }))
    const events = yield* sessions.read(session)
    return { result, calls: yield* turnModelCallsOf(events, 1), selected: yield* turnUsageOf(events, 1), billed: yield* turnBilledUsageOf(events, 1), events }
  })).pipe(
    Effect.provideService(CurrentAgentRun, Option.some({ id: RunId.make("parent-run"), turn: 99, ordinal: RunOrdinal.make(9) })),
    Effect.provideService(CurrentAgentStep, Option.some(9)),
  ))
  expect(observed.calls.map((call) => [String(call.callId), Option.getOrNull(call.run), Option.getOrNull(call.step)])).toEqual([
    ["bootstrap:outside", null, null], ["policy:0", 0, 0], ["maintenance:0", 0, 0], ["loop:0", 0, 0],
    ["policy:1", 1, 0], ["maintenance:1", 1, 0], ["loop:1", 1, 0], ["closing:outside", null, null],
  ])
  expect(observed.result.usage.totalTokens).toBe(24)
  expect(observed.selected.totalTokens).toBe(24)
  expect(observed.billed.totalTokens).toBe(96)
  expect(observed.events.filter((event) => event.kind === "model.called")).toHaveLength(8)
  expect(observed.events.findIndex((event) => event.kind === "model.called")).toBeLessThan(observed.events.findIndex((event) => event.kind === "memory.system"))
})

test("journey: afterRun helper is durable before the final reply and turn-owner closing helper", async () => {
  const phases: string[] = []
  const endInput: { messages: number; step: Option.Option<number>; run: Option.Option<number> }[] = []
  const afterPolicy: MemoryPolicy = { ...memoryPolicy, maintain: ({ entries, signal }) => Effect.gen(function* () {
    phases.push(signal.phase)
    if (signal.phase === "turn-end") {
      endInput.push({ messages: entries.filter((entry) => entry.body._tag === "Message").length, step: yield* CurrentAgentStep,
        run: Option.map(yield* CurrentAgentRun, (run) => run.ordinal) })
      yield* completion("after-run", "Helper").pipe(Effect.orDie)
    }
    return { actions: [], digest: [] }
  }) }
  const afterMemory = definePlugin({
    id: "fixture/after-run-memory", version: "1", scope: "runtime", config: Schema.Struct({}), defaults: {}, provides: [ConversationMemory],
    layer: () => Layer.succeed(ConversationMemory, { strategy: afterPolicy.strategy, open: (input) => openLogSession(input.log, afterPolicy, { runId: input.runId }) }),
  })
  const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const sessions = Context.get(yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)))), Sessions)
    const session = { owner: "fixture", id: ConversationId.make("00000000-0000-4000-8000-000000000019") }
    yield* sessions.create(session)
    const agent = yield* Agent.define({ plugins: [afterMemory, toolDiscoveryPlugin, stepLoopPlugin, closingHelper],
      turnServices: [LanguageModel.LanguageModel, Sessions], limits: { streaming: false, maxSteps: 1 } })
    const scripted = yield* LanguageModel.make({ generateText: () => completion("loop", "Loop").pipe(Effect.orDie, Effect.as([
      { type: "text", text: "finished" },
      { type: "finish", reason: "stop", usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } }, metadata: { [ENGINE_KEY]: { model: "fixture:actual" } } },
    ])), streamText: () => Stream.die("not scripted") })
    const result = yield* agent.turn({ turn: { session, runId: RunId.make("after-run-billing"), userMessage: new UserMessage({ text: "hello" }) },
      services: Context.make(LanguageModel.LanguageModel, scripted).pipe(Context.add(Sessions, sessions)) }, (turn) => Effect.gen(function* () {
      yield* turn.run({})
      phases.push("reply")
      return yield* turn.reply("custom host reply")
    }))
    const events = yield* sessions.read(session)
    return { result, calls: yield* turnModelCallsOf(events, 1), billed: yield* turnBilledUsageOf(events, 1), events }
  })))
  expect(phases).toEqual(["turn-start", "step", "turn-end", "reply"])
  expect(endInput).toEqual([{ messages: 1, step: Option.none(), run: Option.some(0) }])
  expect(observed.calls.map((call) => [String(call.callId), Option.getOrNull(call.run), Option.getOrNull(call.step)])).toEqual([
    ["loop:0", 0, 0], ["after-run:0", 0, null], ["closing:outside", null, null],
  ])
  expect(observed.result.usage.totalTokens).toBe(12)
  expect(observed.billed.totalTokens).toBe(36)
  expect(observed.events.findIndex((event) => event.kind === "model.called" && event.data.callId === "after-run:0")).toBeLessThan(observed.events.findIndex((event) => event.kind === "turn.ended"))
})
