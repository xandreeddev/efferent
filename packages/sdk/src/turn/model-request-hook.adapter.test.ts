import { expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import type { Scope } from "effect"
import { LanguageModel, Prompt, Toolkit } from "effect/ai"
import type { Tool } from "effect/ai"
import {
  ConversationMemory, CurrentAgentRun, CurrentAgentStep, CurrentModelCallPolicy, CurrentPromptCacheKey,
  describeModel, harnessCodeOf, InboxItemId, mediaFromBase64, ModelRequestHook, openLogSession,
  resolveRequestHeader, RunId, RunOrdinal, SessionLogError, ToolRegistry, TurnMemory, UserMessage, userRoleMessageOf,
} from "@xandreed/core"
import type { MaintainSignal, MemoryPolicy, RunTools, StepPlan, StepRequest, ToolViews, TurnWriter } from "@xandreed/core"
import { estimateTokens, toPromptMessages } from "@xandreed/core/internal"
import { openTurnTools } from "./turn-lifecycle.usecase.functions.js"
import { prepareRun } from "./turn-run.usecase.functions.js"
import type { TurnRunServices } from "./turn-run.usecase.functions.js"
import { TurnLive } from "./turn.adapter.js"
import { recordingTurnWriter } from "./testing.js"

const views: ToolViews = { view: () => Effect.succeed({ text: "", version: "1", subjects: [], artifacts: [], pinned: false }), compact: () => Effect.succeed(Option.none()), digest: () => Effect.succeed(Option.none()) }
const registry = ToolRegistry.of({
  catalog: { version: "1", recipes: [], tools: [] }, open: () => Effect.gen(function* () {
    const toolkit: Toolkit.Toolkit<Record<string, Tool.Any>> = Toolkit.make()
    return { toolkit, handlers: yield* toolkit.toHandlers({}), active: Effect.succeed([]), activate: () => Effect.succeed([]), apply: () => Effect.succeed([]), select: () => Effect.succeed([]), match: (userMessage) => Effect.succeed({ userMessage, skills: [], probabilities: Option.none(), record: Option.none() }), views, pollable: [], skills: [] } satisfies RunTools
  }),
})
const nothing = { actions: [], digest: [] }
const info = (stepIndex: number) => ({ stepIndex, activeTools: [], lastUsage: Option.none() })
const setup = <A, E>(body: Effect.Effect<A, E, TurnRunServices | LanguageModel.LanguageModel | Scope.Scope>, options: {
  readonly maintain?: MemoryPolicy["maintain"]
  readonly writer?: (writer: TurnWriter) => TurnWriter
} = {}) => Effect.scoped(Effect.gen(function* () {
  const old = yield* recordingTurnWriter({ runId: RunId.make("hook-history"), text: "old history ".repeat(500), turn: 1 })
  const recorded = yield* recordingTurnWriter({ runId: RunId.make("hook-run"), text: "hello", turn: 2, history: yield* Ref.get(old.stored) })
  const policy: MemoryPolicy = {
    strategy: { id: "hook-fixture", version: "1" },
    render: { turnContext: "current", replies: true, digests: true, media: { mode: "inline", maxImages: 8, maxChars: 10000 } },
    digestOnWrite: Option.none(), maintain: options.maintain ?? (() => Effect.succeed(nothing)),
  }
  const model = yield* LanguageModel.make({ generateText: () => Effect.succeed([]), streamText: () => Stream.empty })
  return yield* Effect.gen(function* () {
    yield* (yield* TurnMemory).persistMessage
    yield* openTurnTools
    return yield* body
  }).pipe(Effect.provide(TurnLive({ turn: (options.writer ?? ((writer) => writer))(recorded.writer), system: "fixed base" })), Effect.provide(Layer.mergeAll(
    Layer.succeed(ConversationMemory, { strategy: policy.strategy, open: ({ runId, log }) => openLogSession(log, policy, { runId }) }),
    Layer.succeed(ToolRegistry, registry), Layer.succeed(LanguageModel.LanguageModel, describeModel(model, { provider: "fixture", model: "primary", settings: {} })),
  )))
}))
const headers = Effect.gen(function* () {
  const snapshot = yield* (yield* TurnMemory).requestSnapshot
  return yield* Effect.forEach(snapshot.requests, (row) => resolveRequestHeader(snapshot.requestEvents ?? snapshot.requests, row), { concurrency: 1 })
})
const dispatch = (request: StepRequest, step: number, plan: StepPlan) => Effect.gen(function* () {
  const model = Option.isSome(plan.model) ? plan.model.value : yield* LanguageModel.LanguageModel
  yield* request.dispatch(step, { prompt: Prompt.make([{ role: "system", content: plan.system }, ...toPromptMessages(plan.messages)]), tools: [], toolChoice: Option.getOrElse(plan.toolChoice, () => "auto"), model }).pipe(Effect.provideService(CurrentPromptCacheKey, request.cacheKey), Effect.provideService(CurrentModelCallPolicy, request.callPolicy))
})

test.each(["tail", "system"] as const)("hook controls precede the sole %s context, reserves and durable header", async (placement) => {
  const calls: unknown[] = []
  const signals: MaintainSignal[] = []
  const result = await Effect.runPromise(setup(Effect.gen(function* () {
    const prepared = yield* prepareRun({ stepContext: placement, step: () => Effect.succeed({ context: Option.some("policy context"), toolChoice: Option.some("required") }) }, { budgetTokens: 10000 })
    const plan = yield* prepared.request.plan(info(0))
    yield* dispatch(prepared.request, 0, plan)
    yield* prepared.afterRun
    return { plan, headers: yield* headers, entries: yield* (yield* TurnMemory).session.entries }
  }), { maintain: ({ signal }) => Effect.sync(() => { signals.push(signal); return nothing }) }).pipe(Effect.provideService(ModelRequestHook, {
    prepare: (draft) => Effect.gen(function* () {
      calls.push([draft, yield* CurrentAgentRun, yield* CurrentAgentStep])
      return { system: "patched base", context: "hook context", toolChoice: null }
    }),
  })))
  const context = "policy context\n\n[Host note: hook context]"
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual([{ run: { id: "hook-run", turn: 2, ordinal: 0 }, step: 0, activeTools: [], system: "fixed base", context: Option.some("policy context"), toolChoice: Option.some("required") }, Option.some({ id: "hook-run", turn: 2, ordinal: 0 }), Option.some(0)])
  expect(result.plan.system).toBe(placement === "system" ? `patched base\n\n${context}` : "patched base")
  expect(result.plan.toolChoice).toEqual(Option.none())
  expect(result.entries.flatMap((entry) => entry.body._tag === "StepContext" ? [entry.body.text] : [])).toEqual([context])
  expect(result.headers[0]?.hook).toEqual({ system: "patched base", context: "hook context", toolChoice: null })
  expect(result.headers[0]?.system).toBe(result.plan.system)
  expect(result.headers[0]?.toolChoice).toBe("auto")
  expect(result.headers[0]?.stableMessages).toBe(result.plan.messages.length - (placement === "tail" ? 1 : 0))
  expect(signals.find((signal) => signal.phase === "step")?.budgetTokens).toBe(10000 - estimateTokens(result.plan.system))
  expect(signals.at(-1)?.budgetTokens).toBe(10000 - estimateTokens("patched base"))
})

test("no hook and an accepted empty patch preserve model bytes without a fabricated context", async () => {
  const result = await Effect.runPromise(setup(Effect.gen(function* () {
    const first = yield* prepareRun({})
    const plain = yield* first.request.plan(info(0))
    const second = yield* prepareRun({})
    const empty = yield* second.request.plan(info(0)).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed({}) }))
    return { plain, empty, headers: yield* headers, entries: yield* (yield* TurnMemory).session.entries }
  })))
  expect(result.empty.system).toBe(result.plain.system)
  expect(result.empty.messages).toEqual(result.plain.messages)
  expect(result.headers.map((header) => header.hook)).toEqual([undefined, {}])
  expect(result.entries.filter((entry) => entry.body._tag === "StepContext")).toEqual([])
})

test("a returned patch is detached before a held context acknowledgment", async () => {
  const patch = { system: "accepted base", context: "accepted context" }
  const result = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    return yield* setup(Effect.gen(function* () {
      const prepared = yield* prepareRun({})
      const pending = yield* prepared.request.plan(info(0)).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      patch.system = "mutated base"; patch.context = "mutated context"
      const before = yield* headers
      yield* Deferred.succeed(release, undefined)
      const plan = yield* Fiber.join(pending)
      return { before, plan, headers: yield* headers }
    }), { writer: (writer) => ({ ...writer, append: (drafts) => writer.append(drafts).pipe(Effect.andThen(drafts.some((draft) => draft.kind === "memory.step") ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)) }) }).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed(patch) }))
  }))
  expect(result.before).toEqual([])
  expect(result.plan.system).toBe("accepted base")
  expect(result.headers[0]?.hook).toEqual({ system: "accepted base", context: "accepted context" })
})

test.each(["memory.step", "request.prepared"])("%s acknowledgment failures retain their original error", async (kind) => {
  const failure = new SessionLogError({ code: "store.io", message: "fixture acknowledgment failed" })
  const result = await Effect.runPromise(setup(Effect.gen(function* () {
    const prepared = yield* prepareRun({})
    return yield* prepared.request.plan(info(0)).pipe(Effect.result)
  }), { writer: (writer) => ({ ...writer, append: (drafts) => writer.append(drafts).pipe(Effect.andThen(drafts.some((draft) => draft.kind === kind) ? Effect.fail(failure) : Effect.void)) }) }).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed({ context: "hook" }) })))
  expect(result._tag === "Failure" && result.failure).toBe(failure)
})

test("an inactive patch choice fails before context or header publication", async () => {
  const result = await Effect.runPromise(setup(Effect.gen(function* () {
    const prepared = yield* prepareRun({})
    const result = yield* prepared.request.plan(info(0)).pipe(Effect.result)
    return { result, headers: yield* headers, entries: yield* (yield* TurnMemory).session.entries }
  })).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.succeed({ context: "never recorded", toolChoice: { tool: "inactive" } }) })))
  expect(result.result._tag === "Failure" && harnessCodeOf(result.result.failure)).toEqual(Option.some("request.hook"))
  expect(result.headers).toEqual([])
  expect(result.entries.filter((entry) => entry.body._tag === "StepContext")).toEqual([])
})

test("a held hook remains interruptible without publishing context or a header", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    return yield* setup(Effect.gen(function* () {
      const prepared = yield* prepareRun({})
      const pending = yield* prepared.request.plan(info(0)).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(pending)
      const exit = yield* Fiber.await(pending)
      return { exit, headers: yield* headers }
    })).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }))
  }))
  expect(result.exit._tag === "Failure" && Cause.hasInterrupts(result.exit.cause)).toBe(true)
  expect(result.headers).toEqual([])
})

test("overflow reuses the hook patch and combined context in its reduced V2 header", async () => {
  const calls: number[] = []
  const result = await Effect.runPromise(setup(Effect.gen(function* () {
    const prepared = yield* prepareRun({ step: () => Effect.succeed({ context: Option.some("policy"), toolChoice: Option.none() }) }, { budgetTokens: 10000 })
    const first = yield* prepared.request.plan(info(0))
    yield* dispatch(prepared.request, 0, first)
    const retry = yield* prepared.request.onContextOverflow!(0)
    const second = yield* prepared.request.plan(info(0))
    yield* dispatch(prepared.request, 0, second)
    return { retry, first, second, headers: yield* headers, entries: yield* (yield* TurnMemory).session.entries }
  }), { maintain: ({ signal }) => Effect.succeed(signal.phase === "overflow" ? { actions: [{ _tag: "DropTurns", throughTurn: 1, ledger: "old history retained" }], digest: [] } : nothing) }).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.sync(() => { calls.push(1); return { system: `hook ${calls.length}`, context: `context ${calls.length}` } }) })))
  expect(result.retry).toBe(true)
  expect(calls).toEqual([1])
  expect(result.second.system).toBe(result.first.system)
  expect(JSON.stringify(result.second.messages).length).toBeLessThan(JSON.stringify(result.first.messages).length)
  expect(result.headers.map((header) => header.hook)).toEqual([{ system: "hook 1", context: "context 1" }, { system: "hook 1", context: "context 1" }])
  expect(result.entries.filter((entry) => entry.body._tag === "StepContext")).toHaveLength(1)
})

test("media replanning reuses the decision while a fresh next step calls the hook again", async () => {
  const calls: number[] = []
  const result = await Effect.runPromise(setup(Effect.gen(function* () {
    const pixel = yield* mediaFromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF1kAAAAASUVORK5CYII=")
    const prepared = yield* prepareRun({})
    yield* (yield* TurnMemory).session.record([{ _tag: "Message", run: RunOrdinal.make(0), inbox: InboxItemId.make("fixture-image"), message: userRoleMessageOf(new UserMessage({ text: "look", attachments: [pixel] })) }], 0)
    yield* prepared.request.plan(info(0))
    const retry = yield* prepared.request.onMediaRejected("fixture image refusal")
    const second = yield* prepared.request.plan(info(0))
    yield* prepared.request.plan(info(1))
    return { retry, second, headers: yield* headers, entries: yield* (yield* TurnMemory).session.entries }
  })).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.sync(() => { calls.push(1); return { system: `hook ${calls.length}`, context: `context ${calls.length}` } }) })))
  expect(result.retry).toBe(true)
  expect(calls).toEqual([1, 1])
  expect(result.second.system).toBe("hook 1")
  expect(result.headers.map((header) => header.hook?.system)).toEqual(["hook 1", "hook 1", "hook 2"])
  expect(result.entries.filter((entry) => entry.body._tag === "StepContext")).toHaveLength(2)
})

test("concurrent runs bind their actual run and step in the captured hook", async () => {
  const seen: unknown[] = []
  const result = await Effect.runPromise(setup(Effect.gen(function* () {
    const first = yield* prepareRun({})
    const second = yield* prepareRun({})
    yield* Effect.all([first.request.plan(info(0)), second.request.plan(info(2))], { concurrency: 2 })
    return yield* headers
  })).pipe(Effect.provideService(ModelRequestHook, { prepare: (draft) => Effect.gen(function* () {
    seen.push([draft.run.ordinal, draft.step, Option.map(yield* CurrentAgentRun, (run) => run.ordinal), yield* CurrentAgentStep])
    return { context: `run ${draft.run.ordinal}` }
  }) })))
  expect(seen).toHaveLength(2)
  expect(seen).toContainEqual([0, 0, Option.some(0), Option.some(0)])
  expect(seen).toContainEqual([1, 2, Option.some(1), Option.some(2)])
  expect(result.toSorted((first, second) => first.run - second.run).map((header) => [header.run, header.step, header.hook])).toEqual([[0, 0, { context: "run 0" }], [1, 2, { context: "run 1" }]])
})
