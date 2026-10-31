import { expect, test } from "bun:test"
import { LanguageModel, Toolkit } from "effect/ai"
import type { Tool } from "effect/ai"
import { Cause, Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import type { Scope } from "effect"
import {
  ConversationMemory, CurrentAgentRun, CurrentAgentStep, describeModel, ENGINE_KEY,
  HarnessError, ModelCallId, ModelId, ModelSelection, openLogSession, ProviderId, recordCompletion, RunId, RunOrdinal,
  StepLoop, tokenUsage, TurnEvents, TurnMemory, TurnPrompt, zeroUsage,
} from "@xandreed/core"
import type { AgentMessage, MaintainSignal, MemoryPolicy, RunResult, RunTools, ToolViews, TurnWriter } from "@xandreed/core"
import { estimateTokens } from "@xandreed/core/internal"
import { ToolRegistry } from "@xandreed/core"
import { recordingTurnWriter } from "./testing.js"
import { TurnLive } from "./turn.adapter.js"
import { openTurnTools } from "./turn-lifecycle.usecase.functions.js"
import { prepareRun, runTurnLoop, stepRequestOf } from "./turn-run.usecase.functions.js"

const views: ToolViews = {
  view: () => Effect.succeed({ text: "", version: "1", subjects: [], artifacts: [], pinned: false }),
  compact: () => Effect.succeed(Option.none()), digest: () => Effect.succeed(Option.none()),
}
const registry = ToolRegistry.of({
  catalog: { version: "1", recipes: [], tools: [] },
  open: () => Effect.gen(function* () {
    const toolkit: Toolkit.Toolkit<Record<string, Tool.Any>> = Toolkit.make()
    return {
      toolkit, handlers: yield* toolkit.toHandlers({}), active: Effect.succeed([]),
      activate: () => Effect.succeed([]), apply: () => Effect.succeed([]), select: () => Effect.succeed([]),
      match: (userMessage) => Effect.succeed({ userMessage, skills: [], probabilities: Option.none(), record: Option.none() }),
      views, pollable: [], skills: [],
    } satisfies RunTools
  }),
})
const result: RunResult = { outcome: "completed", reason: "completed", text: "finished", steps: 0, usage: zeroUsage }
const policy = (maintain: MemoryPolicy["maintain"]): MemoryPolicy => ({
  strategy: { id: "lifecycle", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.none(), maintain,
})
const setup = <A, E>(
  maintain: MemoryPolicy["maintain"], loop: StepLoop["Service"],
  body: Effect.Effect<A, E, import("./turn-run.usecase.functions.js").TurnRunServices | StepLoop | Scope.Scope>,
  decorateWriter: (writer: TurnWriter) => TurnWriter = (writer) => writer,
) => Effect.scoped(Effect.gen(function* () {
  const recorded = yield* recordingTurnWriter({ runId: RunId.make("lifecycle"), text: "hello" })
  const memoryPolicy = policy(maintain)
  const model = yield* LanguageModel.make({ generateText: () => Effect.succeed([]), streamText: () => Stream.die("not called") })
  const services = Layer.mergeAll(
    Layer.succeed(ConversationMemory, { strategy: memoryPolicy.strategy, open: ({ runId, log }) => openLogSession(log, memoryPolicy, { runId }) }),
    Layer.succeed(ToolRegistry, registry), Layer.succeed(StepLoop, loop),
    Layer.succeed(LanguageModel.LanguageModel, describeModel(model, { provider: "fixture", model: "primary", settings: {} })),
  )
  return yield* Effect.gen(function* () {
    yield* (yield* TurnMemory).persistMessage
    yield* openTurnTools
    return yield* body
  }).pipe(Effect.provide(TurnLive({ turn: decorateWriter(recorded.writer), system: "fixed base" })), Effect.provide(services))
}))

test.each([false, true])("successful completed/partial run maintains after the loop (%p)", async (partial) => {
  const phases: string[] = []
  const signals: MaintainSignal[] = []
  const returned = await Effect.runPromise(setup((input) => Effect.sync(() => {
    signals.push(input.signal); phases.push(input.signal.phase); return { actions: [], digest: [] }
  }), { id: "test", version: "1", run: () => Effect.sync(() => { phases.push("loop"); return partial ? { ...result, outcome: "partial", reason: "step-cap" } as const : result }) }, runTurnLoop({}, { budgetTokens: 3000 })))
  expect(phases).toEqual(["turn-start", "loop", "turn-end"])
  expect(returned.outcome).toBe(partial ? "partial" : "completed")
  expect(signals.at(-1)?.render).toEqual({ run: RunOrdinal.make(0), stepContext: "none" })
})

test("a failed loop preserves its failure and skips normal after-run maintenance", async () => {
  const phases: string[] = []
  const failure = new HarnessError({ code: "loop.failed", message: "fixture loop failed" })
  const exit = await Effect.runPromise(setup((input) => Effect.sync(() => { phases.push(input.signal.phase); return { actions: [], digest: [] } }),
    { id: "test", version: "1", run: () => Effect.fail(failure) }, runTurnLoop({}).pipe(Effect.result)))
  expect(exit._tag === "Failure" && exit.failure).toBe(failure)
  expect(phases).toEqual(["turn-start"])
})

test("stepRequestOf remains preparation-only", async () => {
  const phases: string[] = []
  await Effect.runPromise(setup((input) => Effect.sync(() => { phases.push(input.signal.phase); return { actions: [], digest: [] } }),
    { id: "test", version: "1", run: () => Effect.die("not called") }, stepRequestOf({})))
  expect(phases).toEqual(["turn-start"])
})

test("a system StepContext is reserved in the actual request before maintenance", async () => {
  const signals: MaintainSignal[] = []
  const text = "volatile context ".repeat(30)
  await Effect.runPromise(setup((input) => Effect.sync(() => { signals.push(input.signal); return { actions: [], digest: [] } }), {
    id: "test", version: "1", run: (request) => request.plan({ stepIndex: 0, activeTools: [], lastUsage: Option.none() }).pipe(Effect.as(result)),
  }, runTurnLoop({ stepContext: "system", step: () => Effect.succeed({ context: Option.some(text), toolChoice: Option.none() }) }, { budgetTokens: 3000 })))
  expect(signals.find((signal) => signal.phase === "step")?.budgetTokens).toBe(3000 - estimateTokens(`fixed base\n\n${text}`))
  expect(signals.at(-1)?.budgetTokens).toBe(3000 - estimateTokens("fixed base"))
})

const selected = new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("primary") })
const accepted = { model: Option.some(selected), inputTokens: Option.some(1500) }
const stamped: AgentMessage = { role: "assistant", content: [{ type: "text", text: "accepted answer" }], providerOptions: { [ENGINE_KEY]: tokenUsage({ inputTokens: 1500, outputTokens: 4 }) } }
const info = (stepIndex: number) => ({ stepIndex, activeTools: [], lastUsage: Option.none() })
const unusedLoop: StepLoop["Service"] = { id: "test", version: "1", run: () => Effect.die("not called") }
const track = (signals: MaintainSignal[]): MemoryPolicy["maintain"] => ({ signal }) => Effect.sync(() => { signals.push(signal); return { actions: [], digest: [] } })

test("manual prepareRun returns a cached, scope-free afterRun with exact run correlation", async () => {
  const signals: MaintainSignal[] = []
  const correlation: unknown[] = []
  await Effect.runPromise(setup(({ signal }) => Effect.gen(function* () {
    signals.push(signal)
    correlation.push([Option.getOrNull(yield* CurrentAgentRun)?.ordinal, Option.getOrNull(yield* CurrentAgentStep)])
    return { actions: [], digest: [] }
  }), unusedLoop, Effect.gen(function* () {
    const prepared = yield* prepareRun({}, { budgetTokens: 3000 })
    yield* Effect.all([prepared.afterRun, prepared.afterRun], { concurrency: 2 })
    yield* prepared.afterRun
  })))
  expect(signals.map((signal) => signal.phase)).toEqual(["turn-start", "turn-end"])
  expect(signals[1]?.budgetTokens).toBe(3000)
  expect(correlation).toEqual([[0, null], [0, null]])
})

test("interrupting the first afterRun caller retains that terminal outcome without rerunning maintenance", async () => {
  const calls: number[] = []
  const returned = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    return yield* setup(({ signal }) => signal.phase !== "turn-end" ? Effect.succeed({ actions: [], digest: [] }) : Effect.gen(function* () {
      calls.push(1)
      if (calls.length === 1) {
        yield* Deferred.succeed(entered, undefined)
        return yield* Effect.never
      }
      return { actions: [], digest: [] }
    }), unusedLoop, Effect.gen(function* () {
      const prepared = yield* prepareRun({})
      const first = yield* prepared.afterRun.pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(first)
      return yield* prepared.afterRun.pipe(Effect.exit)
    }))
  }))
  expect(calls).toHaveLength(1)
  expect(returned._tag === "Failure" && Cause.hasInterrupts(returned.cause)).toBe(true)
})

test("interrupting a joining afterRun caller leaves the original maintenance and result intact", async () => {
  const calls: number[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* setup(({ signal }) => signal.phase !== "turn-end" ? Effect.succeed({ actions: [], digest: [] }) : Effect.gen(function* () {
      calls.push(1)
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
      return { actions: [], digest: [] }
    }), unusedLoop, Effect.gen(function* () {
      const prepared = yield* prepareRun({})
      const owner = yield* prepared.afterRun.pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const joining = yield* prepared.afterRun.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(joining)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(owner)
      yield* prepared.afterRun
    }))
  }))
  expect(calls).toHaveLength(1)
})

test.each([true, false])("afterRun uses the accepted step reserve despite an unsent lookahead plan (usable=%p)", async (usable) => {
  const signals: MaintainSignal[] = []
  const short = "short base"
  const long = "long base ".repeat(100)
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const prompt = yield* TurnPrompt
    const service = yield* LanguageModel.make({ generateText: () => Effect.succeed([]), streamText: () => Stream.empty })
    const model = describeModel(service, { provider: "fixture", model: "primary", settings: {} })
    const prepared = yield* prepareRun({ model: (info) => Effect.succeed(Option.some({ model, variant: Option.some(info.stepIndex === 0 ? "short" : "long") })) }, { budgetTokens: 3000 }).pipe(
      Effect.provideService(TurnPrompt, { ...prompt, system: (variant) => Effect.succeed(Option.contains(variant, "long") ? long : short) }),
    )
    yield* prepared.request.plan(info(0))
    yield* prepared.request.record(0, [], { ...accepted, inputTokens: usable ? accepted.inputTokens : Option.none() })
    yield* prepared.request.plan(info(1))
    yield* prepared.afterRun
  })))
  expect(signals.at(-1)?.budgetTokens).toBe(3000 - estimateTokens(short))
  expect(signals.at(-1)?.observed?.reservedTokens).toBe(usable ? estimateTokens(short) : undefined)
})

test("afterRun takes the writer's fresh durable snapshot before advisory maintenance", async () => {
  const order: string[] = []
  await Effect.runPromise(setup(({ signal }) => Effect.sync(() => {
    if (signal.phase === "turn-end") order.push("maintain")
    return { actions: [], digest: [] }
  }), unusedLoop, Effect.gen(function* () {
    const prepared = yield* prepareRun({})
    order.length = 0
    yield* prepared.afterRun
  }), (writer) => ({ ...writer, snapshot: (kinds, after) => Effect.sync(() => { order.push("snapshot"); }).pipe(Effect.andThen(writer.snapshot(kinds, after))) })))
  // Recorder-owner closure also snapshots after this body returns.
  expect(order.slice(0, 2)).toEqual(["snapshot", "maintain"])
})

test("an interrupted loop skips afterRun", async () => {
  const signals: MaintainSignal[] = []
  await Effect.runPromise(setup(track(signals), { ...unusedLoop, run: () => Effect.interrupt }, runTurnLoop({}).pipe(Effect.exit)))
  expect(signals.map((signal) => signal.phase)).toEqual(["turn-start"])
})

test("accepted input uses the frozen pre-reaction message estimate and preserves last step usage", async () => {
  const signals: MaintainSignal[] = []
  const built: { estimatedTokens: number; reservedTokens: number }[] = []
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const memory = yield* TurnMemory
    const bus = yield* TurnEvents
    yield* bus.subscribe((event) => event._tag === "context.built" ? Option.some(event) : Option.none(), (event) => Effect.gen(function* () {
      built.push(event)
      yield* memory.session.record([{ _tag: "Message", run: event.run, message: { role: "user", content: "concurrent arrival ".repeat(200) } }], event.step)
    }))
    const prepared = yield* prepareRun({}, { budgetTokens: 5000 })
    yield* prepared.request.plan(info(0))
    yield* prepared.request.record(0, [stamped], accepted)
    yield* prepared.request.record(0, [{ role: "user", content: "ordinary omitted write" }])
    yield* prepared.request.plan(info(1))
    yield* prepared.afterRun
  })))
  const next = signals.filter((signal) => signal.phase === "step")[1]
  expect(next?.observed).toEqual({ model: selected, inputTokens: 1500, estimatedTokens: built[0]!.estimatedTokens, reservedTokens: built[0]!.reservedTokens })
  expect(signals.at(-1)?.observed).toEqual(next?.observed)
  expect(Option.getOrNull(signals.at(-1)?.lastUsage ?? Option.none())).toEqual(tokenUsage({ inputTokens: 1500, outputTokens: 4 }))
  expect(built[1]!.estimatedTokens).toBeGreaterThan(built[0]!.estimatedTokens)
})

test("supplied unusable input clears calibration, while an empty accepted tail still calibrates", async () => {
  const signals: MaintainSignal[] = []
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const { request, afterRun } = yield* prepareRun({})
    yield* request.plan(info(0))
    yield* request.record(0, [], accepted)
    yield* request.plan(info(1))
    yield* request.record(1, [], { model: Option.some(selected), inputTokens: Option.none() })
    yield* request.plan(info(2))
    yield* afterRun
  })))
  const steps = signals.filter((signal) => signal.phase === "step")
  expect(steps[1]?.observed?.inputTokens).toBe(1500)
  expect(steps[2]?.observed).toBeUndefined()
  expect(signals.at(-1)?.observed).toBeUndefined()
})

test("fallback observation is advisory afterRun but cannot calibrate a later primary", async () => {
  const signals: MaintainSignal[] = []
  const fallback = new ModelSelection({ provider: ProviderId.make("fallback"), modelId: selected.modelId })
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const { request, afterRun } = yield* prepareRun({})
    yield* request.plan(info(0))
    yield* request.record(1, [], accepted)
    yield* request.plan(info(1))
    yield* request.record(1, [], { ...accepted, model: Option.some(fallback) })
    yield* request.plan(info(2))
    yield* afterRun
  })))
  expect(signals.filter((signal) => signal.phase === "step").every((signal) => signal.observed === undefined)).toBe(true)
  expect(signals.at(-1)?.observed?.model).toEqual(fallback)
  expect(signals.at(-1)?.observed?.inputTokens).toBe(1500)
})

test("a later selected fallback can use its own accepted calibration", async () => {
  const signals: MaintainSignal[] = []
  const fallback = new ModelSelection({ provider: ProviderId.make("fallback"), modelId: selected.modelId })
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const service = yield* LanguageModel.make({ generateText: () => Effect.succeed([]), streamText: () => Stream.die("not called") })
    const chosen = describeModel(service, { provider: "fallback", model: "primary", settings: {} })
    const { request } = yield* prepareRun({ model: (info) => Effect.succeed(info.stepIndex === 2 ? Option.some({ model: chosen, variant: Option.none() }) : Option.none()) })
    yield* request.plan(info(0))
    yield* request.record(0, [], { ...accepted, model: Option.some(fallback) })
    yield* request.plan(info(1))
    yield* request.plan(info(2))
  })))
  const steps = signals.filter((signal) => signal.phase === "step")
  expect(steps[1]?.observed).toBeUndefined()
  expect(steps[2]?.observed?.model).toEqual(fallback)
})

test("accepted metadata is snapshotted before a held durable tail ACK", async () => {
  const signals: MaintainSignal[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    yield* setup(track(signals), unusedLoop, Effect.gen(function* () {
      const { request, afterRun } = yield* prepareRun({})
      yield* request.plan(info(0))
      const fact = { ...accepted }
      const recording = yield* request.record(0, [stamped], fact).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      fact.inputTokens = Option.some(9999)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(recording)
      yield* afterRun
    }), (writer) => ({ ...writer, append: (drafts) => drafts.some((draft) => draft.kind === "memory.message")
      ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(writer.append(drafts)))
      : writer.append(drafts) }))
  }))
  expect(signals.at(-1)?.observed?.inputTokens).toBe(1500)
})

test("failed tail ACK cannot publish accepted calibration", async () => {
  const signals: MaintainSignal[] = []
  const failure = new HarnessError({ code: "memory.log", message: "held tail ACK failed" })
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const { request, afterRun } = yield* prepareRun({})
    yield* request.plan(info(0))
    const recorded = yield* request.record(0, [stamped], accepted).pipe(Effect.result)
    expect(recorded._tag === "Failure" && recorded.failure).toBe(failure)
    yield* afterRun
  }), (writer) => ({ ...writer, append: (drafts) => drafts.some((draft) => draft.kind === "memory.message") ? Effect.fail(failure) : writer.append(drafts) })))
  expect(signals.at(-1)?.observed).toBeUndefined()
  expect(Option.isNone(signals.at(-1)?.lastUsage ?? Option.none())).toBe(true)
})

test("independent concurrent preparations keep their measurement and once-only maintenance", async () => {
  const signals: MaintainSignal[] = []
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const first = yield* prepareRun({}, { budgetTokens: 3000 })
    const second = yield* prepareRun({}, { budgetTokens: 4000 })
    yield* Effect.all([first.request.plan(info(0)), second.request.plan(info(0))], { concurrency: 2 })
    yield* first.request.record(0, [], accepted)
    yield* Effect.all([first.afterRun, second.afterRun, first.afterRun], { concurrency: 3 })
  })))
  const ends = signals.filter((signal) => signal.phase === "turn-end").toSorted((a, b) => (a.render?.run ?? 0) - (b.render?.run ?? 0))
  expect(ends.map((signal) => [signal.render?.run, signal.budgetTokens, signal.observed?.inputTokens])).toEqual([[0, 3000 - estimateTokens("fixed base"), 1500], [1, 4000 - estimateTokens("fixed base"), undefined]])
})

test("manual afterRun restores the original recorder defect as a sticky TurnError", async () => {
  const failure = new HarnessError({ code: "memory.log", message: "recorder ACK failed" })
  const helpers: string[] = []
  const errors = await Effect.runPromise(setup(({ signal }) => signal.phase === "turn-end"
    ? Effect.gen(function* () {
      helpers.push("helper")
      const run = yield* CurrentAgentRun
      yield* recordCompletion({ callId: ModelCallId.make("after-run-helper"), attempt: 1, purpose: "Helper", method: "Text", model: Option.some(selected),
        runId: Option.map(run, (run) => run.id), run: Option.map(run, (run) => run.ordinal), step: Option.none(), durationMs: 1,
        usage: { _tag: "Known", usage: zeroUsage }, outcome: { _tag: "Completed" } }).pipe(Effect.orDie)
      return { actions: [], digest: [] }
    })
    : Effect.succeed({ actions: [], digest: [] }), unusedLoop, Effect.gen(function* () {
    const prepared = yield* prepareRun({})
    return yield* Effect.all([prepared.afterRun.pipe(Effect.result), prepared.afterRun.pipe(Effect.result)], { concurrency: 2 })
  }), (writer) => ({ ...writer, append: (drafts) => drafts.some((draft) => draft.kind === "model.called") ? Effect.fail(failure) : writer.append(drafts) })))
  expect(helpers).toEqual(["helper"])
  expect(errors.map((error) => error._tag === "Failure" && error.failure)).toEqual([failure, failure])
})
