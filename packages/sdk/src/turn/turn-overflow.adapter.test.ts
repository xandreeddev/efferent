import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import type { Scope } from "effect"
import { LanguageModel, Prompt, Toolkit } from "effect/ai"
import type { Tool } from "effect/ai"
import {
  ConversationMemory, CurrentAgentRun, CurrentAgentStep, CurrentModelCallPolicy, CurrentPromptCacheKey,
  describeModel, HarnessError, ModelCallId, ModelCatalog, ModelId, ModelSelection, openLogSession, ProviderId,
  recordCompletion, RunId, TurnEvents, TurnMemory, TurnPrompt, ToolRegistry, zeroUsage,
} from "@xandreed/core"
import type { MaintainSignal, MemoryPolicy, ModelLimits, RunTools, StepPlan, StepRequest, ToolViews, TurnWriter } from "@xandreed/core"
import { estimateTokens, modelRequestHeaderOf, reconstructModelRequest, toPromptMessages } from "@xandreed/core/internal"
import { TurnLive } from "./turn.adapter.js"
import { openTurnTools } from "./turn-lifecycle.usecase.functions.js"
import { prepareRun } from "./turn-run.usecase.functions.js"
import type { TurnRunServices } from "./turn-run.usecase.functions.js"
import { recordingTurnWriter } from "./testing.js"

const views: ToolViews = { view: () => Effect.succeed({ text: "", version: "1", subjects: [], artifacts: [], pinned: false }), compact: () => Effect.succeed(Option.none()), digest: () => Effect.succeed(Option.none()) }
const registry = ToolRegistry.of({
  catalog: { version: "1", recipes: [], tools: [] }, open: () => Effect.gen(function* () {
    const toolkit: Toolkit.Toolkit<Record<string, Tool.Any>> = Toolkit.make()
    return { toolkit, handlers: yield* toolkit.toHandlers({}), active: Effect.succeed([]), activate: () => Effect.succeed([]), apply: () => Effect.succeed([]), select: () => Effect.succeed([]), match: (userMessage) => Effect.succeed({ userMessage, skills: [], probabilities: Option.none(), record: Option.none() }), views, pollable: [], skills: [] } satisfies RunTools
  }),
})
const selected = new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("primary") })
const evidence = (limits: ModelLimits = {}) => ({ model: selected, limits })
const info = (stepIndex: number) => ({ stepIndex, activeTools: [], lastUsage: Option.none() })
const nothing = { actions: [], digest: [] }
const compact: MemoryPolicy["maintain"] = ({ signal }) => Effect.succeed(signal.phase === "overflow" ? { actions: [{ _tag: "DropTurns", throughTurn: 1, ledger: "old history retained" }], digest: [] } : nothing)
const setup = <A, E>(maintain: MemoryPolicy["maintain"], body: Effect.Effect<A, E, TurnRunServices | LanguageModel.LanguageModel | Scope.Scope>, decorate: (writer: TurnWriter) => TurnWriter = (writer) => writer) => Effect.scoped(Effect.gen(function* () {
  const old = yield* recordingTurnWriter({ runId: RunId.make("old-1"), text: "old one ".repeat(500), turn: 1 })
  const next = yield* recordingTurnWriter({ runId: RunId.make("old-2"), text: "old two ".repeat(500), turn: 2, history: yield* Ref.get(old.stored) })
  const recorded = yield* recordingTurnWriter({ runId: RunId.make("overflow"), text: "hello", turn: 3, history: yield* Ref.get(next.stored) })
  const memoryPolicy: MemoryPolicy = { strategy: { id: "overflow-fixture", version: "1" }, render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } }, digestOnWrite: Option.none(), maintain }
  const model = yield* LanguageModel.make({ generateText: () => Effect.succeed([]), streamText: () => Stream.empty })
  return yield* Effect.gen(function* () {
    yield* (yield* TurnMemory).persistMessage
    yield* openTurnTools
    return yield* body
  }).pipe(Effect.provide(TurnLive({ turn: decorate(recorded.writer), system: "fixed base" })), Effect.provide(Layer.mergeAll(
    Layer.succeed(ConversationMemory, { strategy: memoryPolicy.strategy, open: ({ runId, log }) => openLogSession(log, memoryPolicy, { runId }) }),
    Layer.succeed(ToolRegistry, registry), Layer.succeed(LanguageModel.LanguageModel, describeModel(model, { provider: "fixture", model: "primary", settings: {} })),
  )))
}))
const dispatch = (request: StepRequest, step: number, plan: StepPlan) => Effect.gen(function* () {
  const model = Option.isSome(plan.model) ? plan.model.value : yield* LanguageModel.LanguageModel
  yield* request.dispatch(step, { prompt: Prompt.make([{ role: "system", content: plan.system }, ...toPromptMessages(plan.messages)]), tools: [], toolChoice: Option.getOrElse(plan.toolChoice, () => "auto"), model }).pipe(Effect.provideService(CurrentPromptCacheKey, request.cacheKey), Effect.provideService(CurrentModelCallPolicy, request.callPolicy))
})
const recover = (request: StepRequest, step: number, facts = evidence()) => request.onContextOverflow?.(step, facts) ?? Effect.succeed(false)

test("overflow recovery freezes one smaller same-step request without reevaluating policy", async () => {
  const calls: string[] = []
  const signals: MaintainSignal[] = []
  const result = await Effect.runPromise(setup((input) => { signals.push(input.signal); return compact(input) }, Effect.gen(function* () {
    const memory = yield* TurnMemory
    const prepared = yield* prepareRun({ model: () => Effect.sync(() => { calls.push("model"); return Option.none() }), step: () => Effect.sync(() => { calls.push("step"); return { context: Option.some("current context"), toolChoice: Option.none() } }) }, { budgetTokens: 10000, cacheKey: Option.some("frozen-key") }).pipe(Effect.provideService(CurrentModelCallPolicy, Option.some({ effort: "low", maxOutputTokens: 200 })))
    const first = yield* prepared.request.plan(info(0))
    yield* dispatch(prepared.request, 0, first)
    const retried = yield* recover(prepared.request, 0)
    const second = yield* prepared.request.plan(info(0))
    yield* dispatch(prepared.request, 0, second)
    const duplicate = yield* recover(prepared.request, 0)
    yield* prepared.afterRun
    return { retried, duplicate, first, second, headers: (yield* memory.requestSnapshot).requests, entries: yield* memory.session.entries }
  })))
  expect(result.retried).toBe(true)
  expect(result.duplicate).toBe(false)
  expect(calls).toEqual(["model", "step"])
  expect(result.headers).toHaveLength(2)
  expect(result.second.system).toBe(result.first.system)
  expect(JSON.stringify(result.second.messages).length).toBeLessThan(JSON.stringify(result.first.messages).length)
  expect(signals.map((signal) => signal.phase)).toEqual(["turn-start", "step", "overflow", "turn-end"])
  expect(result.entries.filter((entry) => entry.body._tag === "StepContext")).toHaveLength(1)
  const controls = result.headers.map(({ data }) => [data.system, data.model, data.cacheKey, data.callPolicy, data.tools, data.toolChoice])
  expect(controls[0]).toEqual(["fixed base", { provider: "fixture", model: "primary", settings: {} }, "frozen-key", { effort: "low", maxOutputTokens: 200 }, [], "auto"])
  expect(controls[1]).toEqual(controls[0])
})

test.each(["unchanged", "too-small-reduction"] as const)("overflow declines %s without preparing another header", async (mode) => {
  const result = await Effect.runPromise(setup(({ signal }) => Effect.succeed(signal.phase === "overflow" && mode === "too-small-reduction" ? { actions: [{ _tag: "DropTurns", throughTurn: 1, ledger: "almost all old text ".repeat(180) }], digest: [] } : nothing), Effect.gen(function* () {
    const prepared = yield* prepareRun({}, { budgetTokens: 10000 })
    yield* dispatch(prepared.request, 0, yield* prepared.request.plan(info(0)))
    return { retry: yield* recover(prepared.request, 0), headers: (yield* (yield* TurnMemory).requestSnapshot).requests }
  })))
  expect(result.retry).toBe(false)
  expect(result.headers).toHaveLength(1)
})

test("overflow without a validated dispatch declines before maintenance", async () => {
  const phases: string[] = []
  const retry = await Effect.runPromise(setup(({ signal }) => Effect.sync(() => { phases.push(signal.phase); return nothing }), Effect.gen(function* () {
    const { request } = yield* prepareRun({})
    yield* request.plan(info(0))
    return yield* recover(request, 0)
  })))
  expect(retry).toBe(false)
  expect(phases).toEqual(["turn-start", "step"])
})

test("overflow uses the dispatched cut and reserve despite an unsent lookahead", async () => {
  const signals: MaintainSignal[] = []
  const result = await Effect.runPromise(setup((input) => { signals.push(input.signal); return compact(input) }, Effect.gen(function* () {
    const prompt = yield* TurnPrompt
    const model = yield* LanguageModel.LanguageModel
    const prepared = yield* prepareRun({ model: (step) => Effect.succeed(Option.some({ model, variant: Option.some(step.stepIndex === 0 ? "short" : "long") })) }, { budgetTokens: 10000 }).pipe(Effect.provideService(TurnPrompt, { ...prompt, system: (variant) => Effect.succeed(Option.contains(variant, "long") ? "unsent ".repeat(200) : "fixed base") }))
    const first = yield* prepared.request.plan(info(0))
    yield* prepared.request.plan(info(1))
    yield* dispatch(prepared.request, 0, first)
    const retry = yield* recover(prepared.request, 0)
    const second = yield* prepared.request.plan(info(0))
    return { retry, second }
  })))
  expect(result.retry).toBe(true)
  expect(result.second.system).toBe("fixed base")
  expect(signals.find((signal) => signal.phase === "overflow")?.budgetTokens).toBeGreaterThan(1000)
})

test("actual fallback identity chooses its catalog window without inventing a sent output cap", async () => {
  const signals: MaintainSignal[] = []
  const fallback = new ModelSelection({ provider: ProviderId.make("fallback"), modelId: selected.modelId })
  const result = await Effect.runPromise(setup((input) => { signals.push(input.signal); return compact(input) }, Effect.gen(function* () {
    const { request } = yield* prepareRun({}, { budgetTokens: 10000 })
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    return yield* recover(request, 0, { model: fallback, limits: {} })
  })).pipe(Effect.provideService(ModelCatalog, { list: Effect.succeed([
    { selection: "fixture:primary", provider: "fixture", credential: "local" as const, limits: { contextWindow: 20, maxOutputTokens: 10 } },
    { selection: "fallback:primary", provider: "fallback", credential: "local" as const, limits: { contextWindow: 2000, maxOutputTokens: 1500 } },
  ]) })))
  expect(result).toBe(true)
  expect(signals.find((signal) => signal.phase === "overflow")?.budgetTokens).toBe(Math.floor(0.8 * (2000 - estimateTokens("fixed base"))))
})

test("effective attempted C-output bounds messages, reserving system once", async () => {
  const signals: MaintainSignal[] = []
  const result = await Effect.runPromise(setup(({ signal }) => { signals.push(signal); return Effect.succeed(signal.phase === "overflow" ? { actions: [{ _tag: "DropTurns", throughTurn: 2, ledger: "small" }], digest: [] } : nothing) }, Effect.gen(function* () {
    const { request, afterRun } = yield* prepareRun({}, { budgetTokens: 10000 })
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    const retry = yield* recover(request, 0, evidence({ contextWindow: 2000, maxOutputTokens: 1000 }))
    const plan = yield* request.plan(info(0))
    yield* dispatch(request, 0, plan)
    yield* request.record(0, [], { model: Option.some(selected), inputTokens: Option.none() })
    yield* afterRun
    return retry
  })))
  expect(result).toBe(true)
  const target = Math.floor(0.8 * (1000 - estimateTokens("fixed base")))
  expect(signals.find((signal) => signal.phase === "overflow")?.budgetTokens).toBe(target)
  expect(signals.at(-1)?.budgetTokens).toBe(target)
})

test("recovery proof uses one frozen matching scale for both failed and reduced M", async () => {
  const measurements: number[] = []
  const signals: MaintainSignal[] = []
  const result = await Effect.runPromise(setup((input) => { signals.push(input.signal); return compact(input) }, Effect.gen(function* () {
    yield* (yield* TurnEvents).subscribe((event) => event._tag === "context.built" ? Option.some(event.estimatedTokens) : Option.none(), (tokens) => Effect.sync(() => { measurements.push(tokens) }))
    const { request } = yield* prepareRun({}, { budgetTokens: 10000 })
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    yield* request.record(0, [], { model: Option.some(selected), inputTokens: Option.some(2 * measurements[0]! + estimateTokens("fixed base")) })
    yield* dispatch(request, 1, yield* request.plan(info(1)))
    return yield* recover(request, 1)
  })))
  expect(result).toBe(true)
  expect(signals.find((signal) => signal.phase === "overflow")?.observed?.inputTokens).toBe(2 * measurements[0]! + estimateTokens("fixed base"))
  // This would be rejected by incorrectly comparing scaled newM to raw oldM.
  expect(2 * measurements[2]!).toBeGreaterThan(measurements[1]!)
})

test("an arrival during maintenance that offsets reduction declines the resend", async () => {
  const sessions: import("@xandreed/core").MemorySession[] = []
  const result = await Effect.runPromise(setup((input) => input.signal.phase !== "overflow" ? Effect.succeed(nothing) : Effect.gen(function* () {
    yield* sessions[0]!.record([{ _tag: "Message", message: { role: "user", content: "arrived ".repeat(700) } }], 0).pipe(Effect.orDie)
    return yield* compact(input)
  }), Effect.gen(function* () {
    const memory = yield* TurnMemory
    sessions.push(memory.session)
    const { request } = yield* prepareRun({})
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    return { retry: yield* recover(request, 0), headers: (yield* memory.requestSnapshot).requests }
  })))
  expect(result.retry).toBe(false)
  expect(result.headers).toHaveLength(1)
})

test("pending and reentrant recovery declines promptly without duplicate helper work", async () => {
  const requests: StepRequest[] = []
  const nested: boolean[] = []
  const result = await Effect.runPromise(setup((input) => input.signal.phase !== "overflow" ? Effect.succeed(nothing) : Effect.gen(function* () {
    nested.push(yield* recover(requests[0]!, 0).pipe(Effect.orDie))
    return yield* compact(input)
  }), Effect.gen(function* () {
    const { request } = yield* prepareRun({})
    requests.push(request)
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    return yield* recover(request, 0)
  })))
  expect(result).toBe(true)
  expect(nested).toEqual([false])
})

test("a recovery recorder defect remains the original sticky hard failure", async () => {
  const failure = new HarnessError({ code: "memory.log", message: "helper recorder failed" })
  const calls: number[] = []
  const result = await Effect.runPromise(setup(({ signal }) => signal.phase !== "overflow" ? Effect.succeed(nothing) : Effect.gen(function* () {
    calls.push(1)
    const run = yield* CurrentAgentRun
    yield* recordCompletion({ callId: ModelCallId.make("overflow-helper"), attempt: 1, purpose: "Helper", method: "Text", model: Option.some(selected),
      runId: Option.map(run, (run) => run.id), run: Option.map(run, (run) => run.ordinal), step: yield* CurrentAgentStep,
      durationMs: 1, usage: { _tag: "Known", usage: zeroUsage }, outcome: { _tag: "Completed" } }).pipe(Effect.orDie)
    return nothing
  }), Effect.gen(function* () {
    const { request } = yield* prepareRun({})
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    return [yield* recover(request, 0).pipe(Effect.result), yield* recover(request, 0).pipe(Effect.result)]
  }), (writer) => ({ ...writer, append: (drafts) => drafts.some((draft) => draft.kind === "model.called") ? Effect.fail(failure) : writer.append(drafts) })))
  expect(calls).toHaveLength(1)
  expect(result.map((exit) => exit._tag === "Failure" && exit.failure)).toEqual([failure, failure])
})

test("a failed retry-header ACK is hard and sticky, with no second append or reinstalled candidate", async () => {
  const failure = new HarnessError({ code: "memory.log", message: "retry header ACK failed" })
  const writes: number[] = []
  const result = await Effect.runPromise(setup(compact, Effect.gen(function* () {
    const { request } = yield* prepareRun({})
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    return [yield* recover(request, 0).pipe(Effect.result), yield* recover(request, 0).pipe(Effect.result)]
  }), (writer) => ({ ...writer, append: (drafts) => {
    if (drafts.some((draft) => draft.kind === "request.prepared")) {
      writes.push(1)
      if (writes.length === 2) return Effect.fail(failure)
    }
    return writer.append(drafts)
  } })))
  expect(writes).toHaveLength(2)
  expect(result.map((exit) => exit._tag === "Failure" && exit.failure)).toEqual([failure, failure])
})

test("interrupted recovery is terminal and a duplicate pending call declines", async () => {
  const calls: number[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    return yield* setup(({ signal }) => signal.phase !== "overflow" ? Effect.succeed(nothing) : Effect.gen(function* () {
      calls.push(1)
      yield* Deferred.succeed(entered, undefined)
      return yield* Effect.never
    }), Effect.gen(function* () {
      const { request } = yield* prepareRun({})
      yield* dispatch(request, 0, yield* request.plan(info(0)))
      const first = yield* recover(request, 0).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const pending = yield* recover(request, 0)
      yield* Fiber.interrupt(first)
      return { pending, later: yield* recover(request, 0).pipe(Effect.exit) }
    }))
  }))
  expect(result.pending).toBe(false)
  expect(result.later._tag).toBe("Failure")
  expect(calls).toHaveLength(1)
})

test("total input ceiling shrinks across steps, while concurrent preparations remain independent", async () => {
  const signals: MaintainSignal[] = []
  const overflows: number[] = []
  const result = await Effect.runPromise(setup((input) => {
    signals.push(input.signal)
    if (input.signal.phase !== "overflow") return Effect.succeed(nothing)
    overflows.push(1)
    return Effect.succeed({ actions: [{ _tag: "DropTurns", throughTurn: overflows.length === 1 ? 1 : 2, ledger: "small" }], digest: [] })
  }, Effect.gen(function* () {
    const first = yield* prepareRun({}, { budgetTokens: 10000 })
    const second = yield* prepareRun({}, { budgetTokens: 9000 })
    yield* dispatch(first.request, 0, yield* first.request.plan(info(0)))
    const one = yield* recover(first.request, 0)
    yield* dispatch(first.request, 0, yield* first.request.plan(info(0)))
    yield* dispatch(first.request, 1, yield* first.request.plan(info(1)))
    const two = yield* recover(first.request, 1)
    yield* first.afterRun
    yield* second.afterRun
    return { one, two }
  })))
  expect(result).toEqual({ one: true, two: true })
  const targets = signals.filter((signal) => signal.phase === "overflow").map((signal) => signal.budgetTokens)
  expect(targets[1]!).toBeLessThan(targets[0]!)
  const ends = signals.filter((signal) => signal.phase === "turn-end")
  expect(ends[0]!.budgetTokens).toBeLessThan(3000)
  expect(ends[1]!.budgetTokens).toBe(9000)
})

test("interrupting a retry-header ACK retains its terminal outcome without another header or helper", async () => {
  const writes: number[] = []
  const calls: number[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    return yield* setup((input) => { if (input.signal.phase === "overflow") calls.push(1); return compact(input) }, Effect.gen(function* () {
      const { request } = yield* prepareRun({})
      yield* dispatch(request, 0, yield* request.plan(info(0)))
      const first = yield* recover(request, 0).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(first)
      return yield* recover(request, 0).pipe(Effect.exit)
    }), (writer) => ({ ...writer, append: (drafts) => {
      if (drafts.some((draft) => draft.kind === "request.prepared")) {
        writes.push(1)
        if (writes.length === 2) return writer.append(drafts).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never))
      }
      return writer.append(drafts)
    } }))
  }))
  expect(result._tag).toBe("Failure")
  expect(writes).toHaveLength(2)
  expect(calls).toHaveLength(1)
})

test("context.built arrival after proof stays outside the frozen retry candidate", async () => {
  const built: number[] = []
  const result = await Effect.runPromise(setup(compact, Effect.gen(function* () {
    const memory = yield* TurnMemory
    yield* (yield* TurnEvents).subscribe((event) => event._tag === "context.built" ? Option.some(event) : Option.none(), (event) => Effect.gen(function* () {
      built.push(1)
      if (built.length === 2) yield* memory.session.record([{ _tag: "Message", message: { role: "user", content: "late candidate arrival" } }], event.step)
    }))
    const { request } = yield* prepareRun({})
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    expect(yield* recover(request, 0)).toBe(true)
    const retry = yield* request.plan(info(0))
    yield* dispatch(request, 0, retry)
    const next = yield* request.plan(info(1))
    return { retry, next }
  })))
  expect(JSON.stringify(result.retry.messages)).not.toContain("late candidate arrival")
  expect(JSON.stringify(result.next.messages)).toContain("late candidate arrival")
})

test("a compaction writer failure is hard even when its code is context.budget", async () => {
  const failure = new HarnessError({ code: "context.budget", message: "writer refused the compaction" })
  const result = await Effect.runPromise(setup(compact, Effect.gen(function* () {
    const { request } = yield* prepareRun({})
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    return yield* recover(request, 0).pipe(Effect.result)
  }), (writer) => ({ ...writer, append: (drafts) => drafts.some((draft) => draft.kind === "memory.compaction") ? Effect.fail(failure) : writer.append(drafts) })))
  expect(result._tag === "Failure" && result.failure).toBe(failure)
})

test("custom models without overflow evidence still use bounded recovery without a catalog", async () => {
  const retry = await Effect.runPromise(setup(compact, Effect.gen(function* () {
    const { request } = yield* prepareRun({})
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    return yield* (request.onContextOverflow?.(0) ?? Effect.succeed(false))
  })))
  expect(retry).toBe(true)
})

test("overflow preserves system StepContext while afterRun releases only its obsolete reserve", async () => {
  const signals: MaintainSignal[] = []
  const text = "current context ".repeat(30)
  const result = await Effect.runPromise(setup((input) => { signals.push(input.signal); return compact(input) }, Effect.gen(function* () {
    const { request, afterRun } = yield* prepareRun({ stepContext: "system", step: () => Effect.succeed({ context: Option.some(text), toolChoice: Option.none() }) })
    const first = yield* request.plan(info(0))
    yield* dispatch(request, 0, first)
    const retry = yield* recover(request, 0)
    const next = yield* request.plan(info(0))
    yield* dispatch(request, 0, next)
    yield* request.record(0, [], { model: Option.some(selected), inputTokens: Option.none() })
    yield* afterRun
    return { retry, first, next }
  })))
  expect(result.retry).toBe(true)
  expect(result.next.system).toBe(`fixed base\n\n${text}`)
  const target = signals.find((signal) => signal.phase === "overflow")!.budgetTokens
  expect(signals.at(-1)!.budgetTokens).toBe(target + estimateTokens(result.first.system) - estimateTokens("fixed base"))
})

test("lost retry-header ACK remains sticky after a reconciled dispatch without a private plan", async () => {
  const failure = new HarnessError({ code: "memory.log", message: "retry header committed without ACK" })
  const writes: number[] = []
  const result = await Effect.runPromise(setup(compact, Effect.gen(function* () {
    const memory = yield* TurnMemory
    const model = yield* LanguageModel.LanguageModel
    const { request } = yield* prepareRun({})
    yield* dispatch(request, 0, yield* request.plan(info(0)))
    const first = yield* recover(request, 0).pipe(Effect.result)
    const snapshot = yield* memory.requestSnapshot
    const header = yield* modelRequestHeaderOf(snapshot.requests, request.run.id, 0, request.run.ordinal)
    const rebuilt = yield* reconstructModelRequest(header, snapshot.entries)
    yield* request.dispatch(0, { prompt: rebuilt.prompt, tools: [], toolChoice: rebuilt.toolChoice, model }).pipe(Effect.provideService(CurrentPromptCacheKey, request.cacheKey), Effect.provideService(CurrentModelCallPolicy, request.callPolicy))
    return [first, yield* recover(request, 0).pipe(Effect.result)]
  }), (writer) => ({ ...writer, append: (drafts) => {
    if (drafts.some((draft) => draft.kind === "request.prepared")) {
      writes.push(1)
      if (writes.length === 2) return writer.append(drafts).pipe(Effect.andThen(Effect.fail(failure)))
    }
    return writer.append(drafts)
  } })))
  expect(writes).toHaveLength(2)
  expect(result.map((exit) => exit._tag === "Failure" && exit.failure)).toEqual([failure, failure])
})
