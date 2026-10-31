import { expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { ConversationId, ConversationMemory, estimateMessageTokens, entryId, HarnessError, harnessDefectsAsFailures, ModelId, ModelSelection, openLogSession, ProviderId, renderLog, RunId, RunOrdinal, UserMessage, UtilityCompletion, UtilityError, UtilityLlm, zeroUsage } from "@xandreed/core"
import type { LogBody, LogEntry, MaintainSignal, MemoryObservation, MemoryPolicy, MemorySession } from "@xandreed/core"
import { memorySummaryDefaults, memorySummaryPlugin, SUMMARY_STRATEGY, summaryPolicy } from "./plugin.adapter.js"

const at = (n: number, turn: number, body: LogBody): LogEntry => ({ id: entryId(RunId.make("test"), n), runId: RunId.make("test"), turn, step: 0, at: 0, body })
const history: ReadonlyArray<LogEntry> = [1, 2, 3, 4].flatMap(turn => [at(turn * 2, turn, { _tag: "TurnStarted", userMessage: new UserMessage({ text: `question${turn}` }) }), at(turn * 2 + 1, turn, { _tag: "Message", message: { role: "assistant", content: [{ type: "text", text: `answer${turn} `.repeat(100) }] } })])
const signal: MaintainSignal = { phase: "turn-end", lastUsage: Option.none(), budgetTokens: 1000, views: { view: () => Effect.die("unused"), compact: () => Effect.succeed(Option.none()), digest: () => Effect.succeed(Option.none()) } }
const input = (policy: MemoryPolicy, entries = history, sent: MaintainSignal = signal) => ({ entries, signal: sent, turn: 4, runId: RunId.make("test"), render: (all: ReadonlyArray<LogEntry>) => renderLog(all, { ...policy.render, strategy: SUMMARY_STRATEGY.id, currentTurn: 4, currentRun: RunId.make("test"), run: RunOrdinal.make(0), stepContext: "none" }) })
const observed: MemoryObservation = { model: new ModelSelection({ provider: ProviderId.make("fixture"), modelId: ModelId.make("actual") }), inputTokens: 2200, estimatedTokens: 1000, reservedTokens: 200 }

const openBuiltIn = (summarize: (prompt: string) => Effect.Effect<string, HarnessError>, keepRatio = memorySummaryDefaults.keepRatio) => Effect.gen(function* () {
  const stored = yield* Ref.make(history)
  const built = yield* memorySummaryPlugin.build({ ...memorySummaryDefaults, keepRatio }, Context.empty())
  const memory = Context.get(built as Context.Context<ConversationMemory>, ConversationMemory)
  return yield* memory.open({ conversation: ConversationId.make("00000000-0000-4000-8000-000000000519"), runId: RunId.make("test"),
    log: { read: Ref.get(stored), append: entries => Ref.update(stored, all => [...all, ...entries]) },
  }).pipe(Effect.provideService(UtilityLlm, UtilityLlm.of({ complete: prompt => summarize(prompt).pipe(
    Effect.map(text => new UtilityCompletion({ text, usage: zeroUsage })), Effect.mapError(error => new UtilityError({ message: error.message })),
  ) })))
})

test("default summaries wait until turn-end and step mode remains a timing opt-in", async () => {
  const calls: number[] = []
  const policy = summaryPolicy(memorySummaryDefaults, () => Effect.sync(() => { calls.push(1); return "summary" }))
  expect((await Effect.runPromise(policy.maintain(input(policy, history, { ...signal, phase: "turn-start" })))).actions).toEqual([])
  expect((await Effect.runPromise(policy.maintain(input(policy, history, { ...signal, phase: "step" })))).actions).toEqual([])
  expect(calls).toHaveLength(0)
  expect((await Effect.runPromise(policy.maintain(input(policy)))).actions).toHaveLength(1)
  const legacy = summaryPolicy({ ...memorySummaryDefaults, summarizeAt: "step" }, () => Effect.succeed("summary"))
  expect((await Effect.runPromise(legacy.maintain(input(legacy, history, { ...signal, phase: "step" })))).actions).toHaveLength(1)
})

test("overflow forces timing and successful cooldown while no older history remains protected", async () => {
  const previous = at(99, 4, { _tag: "Compaction", strategy: "summary", version: "1", action: { _tag: "Summarize", keepFromTurn: 2, summary: "older summary" } })
  const policy = summaryPolicy(memorySummaryDefaults, () => Effect.succeed("summary"))
  expect((await Effect.runPromise(policy.maintain(input(policy, [...history, previous])))).actions).toEqual([])
  expect((await Effect.runPromise(policy.maintain(input(policy, [...history, previous], { ...signal, phase: "overflow" })))).actions).toHaveLength(1)
  const current = history.filter(entry => entry.turn === 4)
  expect((await Effect.runPromise(policy.maintain(input(policy, current, { ...signal, phase: "overflow" })))).actions).toEqual([])
})

test("summary trigger and kept tail both use the same calibrated message estimate", async () => {
  const policy = summaryPolicy({ ...memorySummaryDefaults, keepRatio: 0.6 }, () => Effect.succeed("summary"))
  const raw = estimateMessageTokens(input(policy).render(history))
  const budgetTokens = Math.ceil(raw * 1.6)
  expect((await Effect.runPromise(policy.maintain(input(policy, history, { ...signal, budgetTokens })))).actions).toEqual([])
  const result = await Effect.runPromise(policy.maintain(input(policy, history, { ...signal, budgetTokens, observed })))
  expect(result.actions[0]).toMatchObject({ _tag: "Summarize", keepFromTurn: 4 })
})

test("empty and longer summaries do not record progress or repeatedly buy the same frontier", async () => {
  await Promise.all(["", "x".repeat(80_000)].map(text => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const session = yield* openBuiltIn(() => Ref.update(calls, n => n + 1).pipe(Effect.as(text)), 0.6)
    expect(yield* session.maintain(signal)).toEqual([])
    expect(yield* session.maintain({ ...signal, phase: "overflow" })).toEqual([])
    expect(yield* Ref.get(calls)).toBe(1)
    yield* session.record([{ _tag: "Message", message: { role: "assistant", content: [{ type: "text", text: "new current history ".repeat(200) }] } }], 1)
    yield* session.maintain(signal)
    expect(yield* Ref.get(calls)).toBe(2)
  })))))
})

test("concurrent maintenance declines without holding a provider callback lock", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const session = yield* openBuiltIn(() => Ref.update(calls, n => n + 1).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Deferred.await(release)), Effect.as("summary")))
    const first = yield* Effect.forkChild(session.maintain(signal))
    yield* Deferred.await(entered)
    expect(yield* session.maintain(signal).pipe(Effect.timeout("100 millis"))).toEqual([])
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(first)).toHaveLength(1)
    expect(yield* Ref.get(calls)).toBe(1)
  })).pipe(Effect.timeout("2 seconds")))
})

test("provider callback reentry declines and overflow never resets a failed helper", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const holder = yield* Ref.make(Option.none<MemorySession>())
    const calls = yield* Ref.make(0)
    const session = yield* openBuiltIn(() => Effect.gen(function* () {
      yield* Ref.update(calls, n => n + 1)
      const same = yield* Ref.get(holder).pipe(Effect.flatMap(Effect.fromOption))
      expect(yield* same.maintain(signal)).toEqual([])
      return "summary"
    }).pipe(Effect.orDie))
    yield* Ref.set(holder, Option.some(session))
    expect(yield* session.maintain(signal).pipe(Effect.timeout("100 millis"))).toHaveLength(1)
    expect(yield* Ref.get(calls)).toBe(1)
    const failedCalls = yield* Ref.make(0)
    const failed = yield* openBuiltIn(() => Ref.update(failedCalls, n => n + 1).pipe(Effect.andThen(Effect.fail(new HarnessError({ code: "memory.summary", message: "fixture failed" })))))
    yield* failed.maintain(signal)
    yield* failed.record([{ _tag: "Message", message: { role: "assistant", content: [{ type: "text", text: "new history" }] } }], 1)
    yield* failed.maintain({ ...signal, phase: "overflow" })
    expect(yield* Ref.get(failedCalls)).toBe(1)
  })))
})

test("one public summaryPolicy can be reused across sessions after a failed or nonreducing helper", async () => {
  await Promise.all(["failed", "empty"].map(async first => {
    await Effect.runPromise(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const policy = summaryPolicy(memorySummaryDefaults, () => Ref.getAndUpdate(calls, n => n + 1).pipe(Effect.flatMap(n => n > 0
        ? Effect.succeed("summary") : first === "failed" ? Effect.fail(new HarnessError({ code: "memory.summary", message: "fixture failed" })) : Effect.succeed(""))))
      const open = () => openLogSession({ read: Effect.succeed(history), append: () => Effect.void }, policy, { runId: RunId.make("test") })
      const a = yield* open()
      expect(yield* a.maintain(signal)).toEqual([])
      const b = yield* open()
      expect(yield* b.maintain(signal)).toHaveLength(1)
      expect(yield* Ref.get(calls)).toBe(2)
    }))
  }))
})

test("a session never repurchases an earlier nonprogress frontier when budgets oscillate", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const prompts = yield* Ref.make<ReadonlyArray<string>>([])
    const session = yield* openBuiltIn(prompt => Ref.update(prompts, all => [...all, prompt]).pipe(Effect.as("")), 0.6)
    yield* session.maintain({ ...signal, phase: "overflow", budgetTokens: 200 })
    yield* session.maintain({ ...signal, phase: "overflow", budgetTokens: 1100 })
    yield* session.maintain({ ...signal, phase: "overflow", budgetTokens: 200 })
    expect(yield* Ref.get(prompts).pipe(Effect.map(all => all.length))).toBe(2)
  })))
})

test("a summary timeout preserves a recorder failure raised by cancellation cleanup", async () => {
  const failure = new HarnessError({ code: "events.encode", message: "recorder ACK failed during timeout cleanup" })
  const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const session = yield* openBuiltIn(() => Effect.never.pipe(Effect.ensuring(Effect.die(failure))))
    const running = yield* Effect.forkChild(harnessDefectsAsFailures(session.maintain(signal)).pipe(Effect.exit))
    yield* TestClock.adjust("60 seconds")
    return yield* Fiber.join(running)
  })).pipe(Effect.provide(TestClock.layer())))
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(failure)
})
