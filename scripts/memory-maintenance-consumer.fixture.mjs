/** Key-free memory lifecycle over public source and packed Node/Bun APIs. */
import assert from "node:assert/strict"
import { Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel } from "effect/ai"
import {
  ConversationId, ConversationMemory, CurrentAgentRun, CurrentAgentStep,
  definePlugin, describeModel, ENGINE_KEY, ModelCallId,
  openLogSession, parseModelSelection, readStored, recordCompletion,
  replayModelRequest, RunId, SessionLogMemoryLive, Sessions, StepLoop,
  turnBilledUsageOf, turnModelCallsOf, TurnAdmissionOpen, UserMessage,
  UtilityCompletion, UtilityLlm,
} from "@xandreed/core"
import { stepLoopPlugin } from "@xandreed/plugin-agent-loop"
import { memorySummaryPlugin } from "@xandreed/plugin-memory-summary"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { toolDiscoveryPlugin } from "@xandreed/plugin-tool-discovery"
import { Agent, prepareRun } from "@xandreed/sdk"

const selection = (label) => Option.getOrThrow(parseModelSelection(label))
const counts = (input, output = 1) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
const calls = []
const complete = (purpose, model, usage) => Effect.gen(function* () {
  const run = yield* CurrentAgentRun
  const step = yield* CurrentAgentStep
  const callId = ModelCallId.make(`maintenance-${calls.length + 1}`)
  calls.push({ purpose, model, run: Option.getOrNull(Option.map(run, (value) => value.ordinal)) })
  yield* recordCompletion({
    callId, attempt: 1, purpose, method: "Text", model: Option.some(selection(model)),
    runId: Option.map(run, (value) => value.id), run: Option.map(run, (value) => value.ordinal),
    step: Option.isSome(run) ? step : Option.none(), durationMs: 0,
    usage: { _tag: "Known", usage }, outcome: { _tag: "Completed" },
  })
}).pipe(Effect.catch((error) => Effect.die(error)))

const scripted = (seen, script) => Effect.gen(function* () {
  const served = yield* Ref.make(0)
  const model = yield* LanguageModel.make({
    generateText: (options) => Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(served, (value) => value + 1)
      const reply = script[index] ?? script.at(-1)
      seen.push(options.prompt.content)
      yield* complete("Loop", "scripted:fixture", counts(reply.input))
      return [{ type: "text", text: reply.text }, {
        type: "finish", reason: "stop", usage: { inputTokens: { total: reply.input }, outputTokens: { total: 1 } },
        metadata: { [ENGINE_KEY]: { model: "scripted:fixture" } },
      }]
    }),
    streamText: () => Stream.die("the maintenance fixture does not stream"),
  })
  return describeModel(model, { provider: "scripted", model: "fixture", settings: {} })
})

const report = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "process" } }).pipe(
    Layer.provideMerge(Layer.merge(SessionLogMemoryLive, TurnAdmissionOpen)),
  ))
  const sessions = Context.get(context, Sessions)
  const seen = []
  const helperPrompts = []
  const helper = UtilityLlm.of({ complete: (prompt) => Effect.gen(function* () {
    helperPrompts.push(prompt)
    yield* complete("Helper", "scripted:summary", counts(7, 3))
    return new UtilityCompletion({ text: "Earlier checkpoint preserved.", usage: counts(7, 3), model: selection("scripted:summary") })
  }) })
  const model = yield* scripted(seen, [
    { text: "older-evidence ".repeat(180), input: 400 },
    { text: "second checkpoint", input: 2_000 },
    { text: "third checkpoint", input: 600 },
  ])
  const agent = yield* Agent.define({
    plugins: [memorySummaryPlugin, toolDiscoveryPlugin, stepLoopPlugin],
    turnServices: [LanguageModel.LanguageModel, UtilityLlm],
    limits: { streaming: false, maxSteps: 1 }, budgetTokens: 1_000,
  })
  const address = { id: ConversationId.make("00000000-0000-4000-8000-000000001919"), owner: "maintenance-fixture" }
  yield* sessions.create(address)
  const services = Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, model), Context.add(UtilityLlm, helper))
  const run = (ordinal) => agent.turn({
    turn: { session: address, runId: RunId.make(`maintenance-${ordinal}`), userMessage: new UserMessage({ text: `checkpoint ${ordinal}` }) }, services,
  }, (turn) => turn.run({}).pipe(Effect.map((done) => ({ outcome: done.outcome, reply: Option.some(done.text) }))))
  yield* run(1)
  assert.equal(helperPrompts.length, 0, "the active first turn was summarized away")
  const second = yield* run(2)
  assert.equal(helperPrompts.length, 1, "reported input did not trigger after-run summary")
  assert.deepEqual(calls.map((call) => call.purpose), ["Loop", "Loop", "Helper"], "the helper ran before the second reply")
  assert.equal(JSON.stringify(seen[1]).includes("Earlier checkpoint preserved."), false, "normal summary ran before the second model request")
  const afterSecond = yield* sessions.read(address)
  const compactions = afterSecond.filter((event) => event.kind === "memory.compaction")
  assert.equal(compactions.length, 1)
  assert.equal(compactions[0].turn.value, 2)
  assert.equal(compactions[0].data.body.version, "2")
  assert.equal(compactions[0].data.body.action.keepFromTurn, 2)
  const helperFact = afterSecond.find((event) => event.kind === "model.called" && event.data.purpose === "Helper")
  const ended = afterSecond.find((event) => event.kind === "turn.ended" && event.turn.value === 2)
  assert.ok(helperFact.seq < ended.seq && compactions[0].seq < ended.seq, "maintenance outlived its writer")
  assert.equal((yield* turnBilledUsageOf(afterSecond, 2)).totalTokens, second.usage.totalTokens + 10)
  assert.equal((yield* turnModelCallsOf(afterSecond, 2)).length, 2)
  yield* run(3)
  assert.ok(JSON.stringify(seen[2]).includes("Earlier checkpoint preserved."), "the next request did not use the recorded summary")
  assert.equal(helperPrompts.length, 1, "normal after-run maintenance ignored successful-summary cooldown")
  const all = yield* sessions.read(address)
  const headers = yield* readStored("request.prepared", all)
  yield* Effect.forEach(headers, ({ data }) => replayModelRequest(all, data.runId, data.step, data.run), { concurrency: 1, discard: true })

  // A host using the public pieces gets the same completion lifecycle,
  // without another Scope requirement or a second maintenance invocation.
  const signals = []
  const temporary = `temporary system checkpoint ${"x".repeat(800)}`
  const policy = {
    strategy: { id: "maintenance-fixture", version: "2" },
    render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
    digestOnWrite: Option.none(),
    maintain: ({ entries, render, signal }) => Effect.sync(() => {
      signals.push({ ...signal, messages: render(entries) })
      return { actions: [], digest: [] }
    }),
  }
  const observedMemory = definePlugin({
    id: "consumer/observed-maintenance", version: "1", scope: "runtime",
    config: Schema.Struct({}), defaults: {}, provides: [ConversationMemory],
    layer: () => Layer.succeed(ConversationMemory, ConversationMemory.of({
      strategy: policy.strategy, open: ({ runId, log }) => openLogSession(log, policy, { runId }),
    })),
  })
  const manual = yield* Agent.define({
    plugins: [observedMemory, toolDiscoveryPlugin, stepLoopPlugin],
    turnServices: [LanguageModel.LanguageModel], limits: { streaming: false, maxSteps: 1 },
  })
  const manualAddress = { id: ConversationId.make("00000000-0000-4000-8000-000000001920"), owner: "maintenance-fixture" }
  yield* sessions.create(manualAddress)
  const manualModel = yield* scripted([], [{ text: "manual checkpoint", input: 5_000 }])
  yield* manual.turn({
    turn: { session: manualAddress, runId: RunId.make("manual-maintenance"), userMessage: new UserMessage({ text: "inspect manual composition" }) },
    services: Context.make(Sessions, sessions).pipe(Context.add(LanguageModel.LanguageModel, manualModel)),
  }, () => Effect.gen(function* () {
    const prepared = yield* prepareRun({
      stepContext: "system", step: () => Effect.succeed({ context: Option.some(temporary), toolChoice: Option.none() }),
    }, { limits: { streaming: false, maxSteps: 1 } })
    const done = yield* (yield* StepLoop).run(prepared.request)
    assert.equal(signals.filter((signal) => signal.phase === "turn-end").length, 0)
    yield* prepared.afterRun
    yield* prepared.afterRun
    return { outcome: done.outcome, reply: Option.some(done.text) }
  }))
  const endings = signals.filter((signal) => signal.phase === "turn-end")
  assert.equal(endings.length, 1, "manual afterRun was not cached once")
  const end = endings[0]
  const step = signals.find((signal) => signal.phase === "step")
  assert.equal(end.render.stepContext, "none")
  assert.equal(end.observed.inputTokens, 5_000)
  assert.equal(end.observed.model.modelId, "fixture")
  assert.ok(end.budgetTokens > step.budgetTokens, "obsolete system StepContext remained reserved at turn-end")
  assert.equal(JSON.stringify(end.messages).includes(temporary), false)
  assert.equal(JSON.stringify(step.messages).includes(temporary), false, "system StepContext was counted again in messages")
  return { runtime: typeof Bun === "undefined" ? "Node" : "Bun", summaries: helperPrompts.length, manualAfterRun: endings.length, maintenanceVerified: true }
})).pipe(Effect.timeout("20 seconds")))
console.log(`memory-maintenance ${JSON.stringify(report)}`)
