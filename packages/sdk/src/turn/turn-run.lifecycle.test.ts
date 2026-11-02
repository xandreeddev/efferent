import { expect, test } from "bun:test"
import { LanguageModel, Toolkit } from "effect/ai"
import type { Tool } from "effect/ai"
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect"
import type { Scope } from "effect"
import {
  ConversationMemory, CurrentModelCallPolicy, describeModel, ENGINE_KEY, harnessCodeOf,
  HarnessError, ModelCatalog, ModelId, ModelSelection, openLogSession, ProviderId, RunId, RunOrdinal,
  StepLoop, tokenUsage, TurnEvents, TurnMemory, zeroUsage,
} from "@xandreed/core"
import type { AgentMessage, MaintainSignal, MemoryPolicy, RunResult, RunTools, ToolViews, TurnWriter } from "@xandreed/core"
import { estimateTokens } from "@xandreed/core/internal"
import { ToolRegistry } from "@xandreed/core"
import { recordingTurnWriter } from "./testing.js"
import { TurnLive } from "./turn.adapter.js"
import { openTurnTools } from "./turn-lifecycle.usecase.functions.js"
import { runTurnLoop, stepRequestOf } from "./turn-run.usecase.functions.js"

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

test.each([false, true])("a completed or partial run maintains nothing after its loop returns (%p)", async (partial) => {
  const phases: string[] = []
  const returned = await Effect.runPromise(setup((input) => Effect.sync(() => {
    phases.push(input.signal.phase); return { actions: [], digest: [] }
  }), { id: "test", version: "1", run: () => Effect.sync(() => { phases.push("loop"); return partial ? { ...result, outcome: "partial", reason: "step-cap" } as const : result }) }, runTurnLoop({}, { budgetTokens: 3000 })))
  // The reply goes straight back to the host: nothing can hold it up, fail it or leave it unrecorded.
  expect(phases).toEqual(["turn-start", "loop"])
  expect(returned.outcome).toBe(partial ? "partial" : "completed")
})

test("what a run left is maintained at the next run's start, with that run's scope", async () => {
  const signals: MaintainSignal[] = []
  await Effect.runPromise(setup((input) => Effect.sync(() => { signals.push(input.signal); return { actions: [], digest: [] } }),
    { id: "test", version: "1", run: () => Effect.succeed(result) }, Effect.gen(function* () {
      yield* runTurnLoop({}, { budgetTokens: 3000 })
      yield* runTurnLoop({}, { budgetTokens: 3000 })
    })))
  expect(signals.map((signal) => [signal.phase, signal.render?.run, signal.budgetTokens])).toEqual([
    ["turn-start", RunOrdinal.make(0), 3000], ["turn-start", RunOrdinal.make(1), 3000],
  ])
})

test("a failed loop preserves its failure", async () => {
  const phases: string[] = []
  const failure = new HarnessError({ code: "loop.failed", message: "fixture loop failed" })
  const exit = await Effect.runPromise(setup((input) => Effect.sync(() => { phases.push(input.signal.phase); return { actions: [], digest: [] } }),
    { id: "test", version: "1", run: () => Effect.fail(failure) }, runTurnLoop({}).pipe(Effect.result)))
  expect(exit._tag === "Failure" && exit.failure).toBe(failure)
  expect(phases).toEqual(["turn-start"])
})

test("a waiting run returns its result and an already waiting run skips preparation", async () => {
  const phases: string[] = []
  const returned = await Effect.runPromise(setup((input) => Effect.sync(() => {
    phases.push(input.signal.phase)
    return { actions: [], digest: [] }
  }), { id: "test", version: "1", run: () => Effect.sync(() => {
    phases.push("loop")
    return { ...result, text: "", outcome: "waiting", reason: "waiting" } as const
  }) }, Effect.gen(function* () {
    const first = yield* runTurnLoop({}, { waiting: Effect.succeed(false) })
    const second = yield* runTurnLoop({}, { waiting: Effect.succeed(true) })
    return [first, second]
  })))
  expect(phases).toEqual(["turn-start", "loop"])
  expect(returned.map((value) => [value.outcome, value.reason, value.text, value.steps])).toEqual([
    ["waiting", "waiting", "", 0], ["waiting", "waiting", "", 0],
  ])
})

test("stepRequestOf maintains the run's start, so a manual composition keeps its summaries", async () => {
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
})

const selected = new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("primary") })
const accepted = { model: Option.some(selected), inputTokens: Option.some(1500) }
const stamped: AgentMessage = { role: "assistant", content: [{ type: "text", text: "accepted answer" }], providerOptions: { [ENGINE_KEY]: tokenUsage({ inputTokens: 1500, outputTokens: 4 }) } }
const info = (stepIndex: number) => ({ stepIndex, activeTools: [], lastUsage: Option.none() })
const unusedLoop: StepLoop["Service"] = { id: "test", version: "1", run: () => Effect.die("not called") }
const track = (signals: MaintainSignal[]): MemoryPolicy["maintain"] => ({ signal }) => Effect.sync(() => { signals.push(signal); return { actions: [], digest: [] } })
const catalog = (limits: { readonly contextWindow?: number; readonly maxOutputTokens?: number }) => ModelCatalog.of({
  list: Effect.succeed([{ selection: "fixture:primary", provider: "fixture", credential: "api_key", input: ["text"], limits }]),
})

test.each([
  ["a known window below the budget lowers the step's ceiling", { contextWindow: 2000, maxOutputTokens: 500 }, Option.none(), 1500],
  ["the call policy's output cap wins over the catalog's", { contextWindow: 2000, maxOutputTokens: 500 }, Option.some({ effort: "low", maxOutputTokens: 200 } as const), 1800],
  ["a window above the budget leaves the budget", { contextWindow: 200_000, maxOutputTokens: 500 }, Option.none(), 3000],
  ["an unknown window leaves the budget", { maxOutputTokens: 500 }, Option.none(), 3000],
] as const)("%s", async (_, limits, policy, ceiling) => {
  const signals: MaintainSignal[] = []
  const built: number[] = []
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const bus = yield* TurnEvents
    yield* bus.subscribe((event) => event._tag === "context.built" ? Option.some(event.budgetTokens) : Option.none(), (budget) => Effect.sync(() => { built.push(budget) }))
    const request = yield* stepRequestOf({}, { budgetTokens: 3000 }).pipe(Effect.provideService(CurrentModelCallPolicy, policy))
    yield* request.plan(info(0))
    yield* request.plan(info(1))
  })).pipe(Effect.provideService(ModelCatalog, catalog(limits))))
  expect(signals.filter((signal) => signal.phase === "step").map((signal) => signal.budgetTokens)).toEqual([ceiling - estimateTokens("fixed base"), ceiling - estimateTokens("fixed base")])
  expect(built).toEqual([ceiling, ceiling])
})

test("a known window leaving no room for the system prompt fails the step with context.budget", async () => {
  const exit = await Effect.runPromise(setup(track([]), unusedLoop, Effect.gen(function* () {
    const request = yield* stepRequestOf({}, { budgetTokens: 3000 })
    return yield* request.plan(info(0)).pipe(Effect.result)
  })).pipe(Effect.provideService(ModelCatalog, catalog({ contextWindow: 600, maxOutputTokens: 598 }))))
  expect(exit._tag === "Failure" && Option.getOrNull(harnessCodeOf(exit.failure))).toBe("context.budget")
})

test("accepted input uses the frozen pre-reaction message estimate", async () => {
  const signals: MaintainSignal[] = []
  const built: { estimatedTokens: number; reservedTokens: number }[] = []
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const memory = yield* TurnMemory
    const bus = yield* TurnEvents
    yield* bus.subscribe((event) => event._tag === "context.built" ? Option.some(event) : Option.none(), (event) => Effect.gen(function* () {
      built.push(event)
      yield* memory.session.record([{ _tag: "Message", run: event.run, message: { role: "user", content: "concurrent arrival ".repeat(200) } }], event.step)
    }))
    const request = yield* stepRequestOf({}, { budgetTokens: 5000 })
    yield* request.plan(info(0))
    yield* request.record(0, [stamped], accepted)
    yield* request.record(0, [{ role: "user", content: "ordinary omitted write" }])
    yield* request.plan(info(1))
  })))
  const next = signals.filter((signal) => signal.phase === "step")[1]
  expect(next?.observed).toEqual({ model: selected, inputTokens: 1500, estimatedTokens: built[0]!.estimatedTokens, reservedTokens: built[0]!.reservedTokens })
  expect(built[1]!.estimatedTokens).toBeGreaterThan(built[0]!.estimatedTokens)
})

test("supplied unusable input clears calibration, while an empty accepted tail still calibrates", async () => {
  const signals: MaintainSignal[] = []
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const request = yield* stepRequestOf({})
    yield* request.plan(info(0))
    yield* request.record(0, [], accepted)
    yield* request.plan(info(1))
    yield* request.record(1, [], { model: Option.some(selected), inputTokens: Option.none() })
    yield* request.plan(info(2))
  })))
  const steps = signals.filter((signal) => signal.phase === "step")
  expect(steps[1]?.observed?.inputTokens).toBe(1500)
  expect(steps[2]?.observed).toBeUndefined()
})

test("a fallback observation cannot calibrate a later primary", async () => {
  const signals: MaintainSignal[] = []
  const fallback = new ModelSelection({ provider: ProviderId.make("fallback"), modelId: selected.modelId })
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const request = yield* stepRequestOf({})
    yield* request.plan(info(0))
    yield* request.record(1, [], accepted)
    yield* request.plan(info(1))
    yield* request.record(1, [], { ...accepted, model: Option.some(fallback) })
    yield* request.plan(info(2))
  })))
  expect(signals.filter((signal) => signal.phase === "step").every((signal) => signal.observed === undefined)).toBe(true)
})

test("a later selected fallback can use its own accepted calibration", async () => {
  const signals: MaintainSignal[] = []
  const fallback = new ModelSelection({ provider: ProviderId.make("fallback"), modelId: selected.modelId })
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const service = yield* LanguageModel.make({ generateText: () => Effect.succeed([]), streamText: () => Stream.die("not called") })
    const chosen = describeModel(service, { provider: "fallback", model: "primary", settings: {} })
    const request = yield* stepRequestOf({ model: (info) => Effect.succeed(info.stepIndex === 2 ? Option.some({ model: chosen, variant: Option.none() }) : Option.none()) })
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
      const request = yield* stepRequestOf({})
      yield* request.plan(info(0))
      const fact = { ...accepted }
      const recording = yield* request.record(0, [stamped], fact).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      fact.inputTokens = Option.some(9999)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(recording)
      yield* request.plan(info(1))
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
    const request = yield* stepRequestOf({})
    yield* request.plan(info(0))
    const recorded = yield* request.record(0, [stamped], accepted).pipe(Effect.result)
    expect(recorded._tag === "Failure" && recorded.failure).toBe(failure)
    yield* request.plan(info(1))
  }), (writer) => ({ ...writer, append: (drafts) => drafts.some((draft) => draft.kind === "memory.message") ? Effect.fail(failure) : writer.append(drafts) })))
  expect(signals.at(-1)?.observed).toBeUndefined()
})

test("independent concurrent preparations keep their own measurement", async () => {
  const signals: MaintainSignal[] = []
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const first = yield* stepRequestOf({}, { budgetTokens: 3000 })
    const second = yield* stepRequestOf({}, { budgetTokens: 4000 })
    yield* Effect.all([first.plan(info(0)), second.plan(info(0))], { concurrency: 2 })
    yield* first.record(0, [], accepted)
    yield* Effect.all([first.plan(info(1)), second.plan(info(1))], { concurrency: 2 })
  })))
  const later = signals.filter((signal) => signal.phase === "step").slice(2).toSorted((a, b) => (a.render?.run ?? 0) - (b.render?.run ?? 0))
  expect(later.map((signal) => [signal.render?.run, signal.budgetTokens, signal.observed?.inputTokens])).toEqual([[0, 3000 - estimateTokens("fixed base"), 1500], [1, 4000 - estimateTokens("fixed base"), undefined]])
})

/** A writer that can seal: its seal answers at once, and no one else ever ends the turn. */
const sealing = (writer: TurnWriter): TurnWriter => ({ ...writer, seal: Effect.succeed(Option.some(Effect.never)) })

test("an accepted response hands the run's maintenance to the sealed reply, once, on its accepted input and base reserve", async () => {
  const signals: MaintainSignal[] = []
  const text = "volatile context ".repeat(30)
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const memory = yield* TurnMemory
    const request = yield* stepRequestOf({ stepContext: "system", step: () => Effect.succeed({ context: Option.some(text), toolChoice: Option.none() }) }, { budgetTokens: 3000 })
    yield* request.plan(info(0))
    yield* request.record(0, [stamped], accepted)
    yield* memory.afterReply
    yield* memory.afterReply
  }), sealing))
  const ends = signals.filter((signal) => signal.phase === "turn-end")
  expect(ends).toHaveLength(1)
  expect(ends[0]?.budgetTokens).toBe(3000 - estimateTokens("fixed base"))
  expect(ends[0]?.observed?.inputTokens).toBe(1500)
  expect(ends[0]?.render).toEqual({ run: RunOrdinal.make(0), stepContext: "none" })
  expect(Option.getOrNull(ends[0]?.lastUsage ?? Option.none())).toEqual(tokenUsage({ inputTokens: 1500, outputTokens: 4 }))
})

test("a writer that cannot seal leaves the run's maintenance to the next run's start", async () => {
  const signals: MaintainSignal[] = []
  await Effect.runPromise(setup(track(signals), unusedLoop, Effect.gen(function* () {
    const memory = yield* TurnMemory
    const request = yield* stepRequestOf({})
    yield* request.plan(info(0))
    yield* request.record(0, [stamped], accepted)
    yield* memory.afterReply
  })))
  expect(signals.map((signal) => signal.phase)).toEqual(["turn-start", "step"])
})

test("after the sealed reply an ordinary maintenance failure is skipped, a writer's stays hard", async () => {
  const writerFailure = new HarnessError({ code: "session.defect", message: "the writer died" })
  const results = await Promise.all([new HarnessError({ code: "memory.summary", message: "the summarizer failed" }), writerFailure].map((error) =>
    Effect.runPromise(setup(({ signal }) => signal.phase === "turn-end" ? Effect.fail(error) : Effect.succeed({ actions: [], digest: [] }), unusedLoop, Effect.gen(function* () {
      const memory = yield* TurnMemory
      const request = yield* stepRequestOf({})
      yield* request.plan(info(0))
      yield* request.record(0, [stamped], accepted)
      return yield* memory.afterReply.pipe(Effect.result)
    }), sealing))))
  expect(results[0]?._tag).toBe("Success")
  expect(results[1]?._tag === "Failure" && results[1].failure).toBe(writerFailure)
})
