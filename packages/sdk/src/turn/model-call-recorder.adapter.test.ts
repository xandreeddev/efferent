import { describe, expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema, Scope } from "effect"
import {
  ConversationMemory, CurrentModelCallRecorder, frameworkDraft, harnessCodeOf, HarnessError,
  ModelCallData, ModelCallId, openLogSession, RunId, RunOrdinal, StepUsageData, storedJson, ToolRegistry,
} from "@xandreed/core"
import type { MemoryPolicy, ModelCallRecorder, SessionLogEvent, TurnError } from "@xandreed/core"
import { modelCallRecorderConformance } from "@xandreed/core/conformance"
import type { ModelCallRecorderSubject } from "@xandreed/core/conformance"
import { recordingTurnWriter } from "./testing.js"
import { TurnLive } from "./turn.adapter.js"
import { makeTurnModelCallRecorder } from "./model-call-recorder.adapter.js"

const policy: MemoryPolicy = {
  strategy: { id: "test", version: "1" },
  render: { turnContext: "current", replies: true, digests: true, media: { mode: "none", maxImages: 0, maxChars: 0 } },
  digestOnWrite: Option.none(), maintain: () => Effect.succeed({ actions: [], digest: [] }),
}
const services = Layer.merge(
  Layer.succeed(ConversationMemory, ConversationMemory.of({ strategy: policy.strategy, open: ({ runId, log }) => openLogSession(log, policy, { runId }) })),
  Layer.succeed(ToolRegistry, ToolRegistry.of({ catalog: { version: "1", recipes: [], tools: [] }, open: () => Effect.die("the recorder fixture opens no tools") })),
)
const decode = (events: ReadonlyArray<SessionLogEvent>) => Effect.forEach(events.filter((event) => event.kind === "model.called"), (event) =>
  Schema.decodeUnknownEffect(ModelCallData)(event.data), { concurrency: 1 }).pipe(
  Effect.mapError((cause) => new HarnessError({ code: "events.encode", message: "recorder fixture facts did not decode", cause })),
)

const subject: ModelCallRecorderSubject = {
  open: (seed) => Effect.gen(function* () {
    const recorded = yield* recordingTurnWriter({ runId: RunId.make("recorder-kit"), text: "hello" })
    yield* Effect.forEach(seed.calls, (call) => Schema.encodeEffect(ModelCallData)(call).pipe(
      Effect.flatMap(storedJson), Effect.flatMap((data) => recorded.writer.append([frameworkDraft("model.called", data)])),
    ), { concurrency: 1 })
    yield* Effect.forEach(seed.legacy, (usage, step) => Schema.encodeEffect(StepUsageData)({
      step, run: RunOrdinal.make(0), model: usage.model, usage: usage.usage, finishReason: "stop",
    }).pipe(Effect.flatMap(storedJson), Effect.flatMap((data) => recorded.writer.append([frameworkDraft("step.usage", data)]))), { concurrency: 1 })
    const failure = yield* Ref.make(Option.none<TurnError>())
    const writer = { ...recorded.writer, flush: Ref.getAndSet(failure, Option.none()).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Effect.fail }))) }
    const owner = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void))
    const context = yield* Layer.buildWithScope(TurnLive({ turn: writer }).pipe(Layer.provide(services)), owner)
    const recorder = Context.get(context, CurrentModelCallRecorder)
    if (recorder.observe === undefined) return yield* Effect.die("TurnLive did not provide owner-lifetime model-call observation")
    return {
      recorder: { ...recorder, observe: recorder.observe },
      stored: Ref.get(recorded.stored).pipe(Effect.flatMap(decode)),
      failNext: (error: TurnError) => Ref.set(failure, Option.some(error)),
      close: Scope.close(owner, Exit.void),
    }
  }),
}
const call = (key: string): ModelCallData => ({
  callId: ModelCallId.make(key), attempt: 1, purpose: "Helper", method: "Text", model: Option.none(),
  runId: Option.none(), run: Option.none(), step: Option.none(), durationMs: 1,
  usage: { _tag: "Unknown" }, outcome: { _tag: "Completed" },
})

describe("TurnLive model-call recorder", () => {
  modelCallRecorderConformance(subject).forEach((check) => test(check.name, () => Effect.runPromise(check.run)))

  test("an ordinary bus reaction fails once after durability and billing notification", async () => {
    const failure = new HarnessError({ code: "events.background", message: "fixture reaction failed" })
    const result = await Effect.runPromise(Effect.gen(function* () {
      const stored = yield* recordingTurnWriter({ runId: RunId.make("reaction"), text: "hello" })
      const published = yield* Ref.make(0)
      const billed = yield* Ref.make(0)
      const owned = yield* makeTurnModelCallRecorder(stored.writer, () => Ref.update(published, (n) => n + 1).pipe(Effect.andThen(Effect.fail(failure))))
      yield* owned.recorder.observe?.({ called: () => Ref.update(billed, (n) => n + 1), closed: () => Effect.void }) ?? Effect.void
      const first = yield* Effect.result(owned.recorder.record(call("reaction")))
      const second = yield* Effect.result(owned.recorder.record(call("reaction")))
      return { first, second, stored: yield* Ref.get(stored.stored).pipe(Effect.flatMap(decode)), published: yield* Ref.get(published), billed: yield* Ref.get(billed) }
    }))
    expect(result.first._tag === "Failure" && result.first.failure).toBe(failure)
    expect(result.second._tag === "Failure" && result.second.failure).toBe(failure)
    expect([result.stored.length, result.published, result.billed]).toEqual([1, 1, 1])
  })

  test("a fresh key reconciled from storage cannot publish or append again", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const stored = yield* recordingTurnWriter({ runId: RunId.make("reconciled"), text: "hello" })
      const published = yield* Ref.make(0)
      const seen = yield* Ref.make(0)
      const owned = yield* makeTurnModelCallRecorder(stored.writer, () => Ref.update(published, (n) => n + 1))
      const data = call("reconciled")
      yield* Schema.encodeEffect(ModelCallData)(data).pipe(Effect.flatMap(storedJson), Effect.flatMap((data) => stored.writer.append([frameworkDraft("model.called", data)])))
      yield* owned.recorder.observe?.({ called: () => Ref.update(seen, (n) => n + 1), closed: () => Effect.void }) ?? Effect.void
      yield* owned.recorder.record(data)
      return { stored: yield* Ref.get(stored.stored).pipe(Effect.flatMap(decode)), published: yield* Ref.get(published), seen: yield* Ref.get(seen) }
    }))
    expect([result.stored.length, result.published, result.seen]).toEqual([1, 0, 1])
  })

  test("a masked completion still leaves arbitrary bus reactions interruptible", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const stored = yield* recordingTurnWriter({ runId: RunId.make("masked"), text: "hello" })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const owned = yield* makeTurnModelCallRecorder(stored.writer, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))))
      const running = yield* Effect.forkChild(owned.recorder.record(call("masked")).pipe(Effect.uninterruptible))
      yield* Deferred.await(entered)
      const interrupted = yield* Fiber.interrupt(running).pipe(Effect.timeoutOption("100 millis"), Effect.ensuring(Deferred.succeed(release, undefined)))
      return { interrupted: Option.isSome(interrupted), stored: yield* Ref.get(stored.stored).pipe(Effect.flatMap(decode)) }
    })))
    expect(result.interrupted).toBe(true)
    expect(result.stored).toHaveLength(1)
  })

  test.each([false, true])("same-key notification reentry fails promptly, including child fibers (%p)", async (child) => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const stored = yield* recordingTurnWriter({ runId: RunId.make("reentry"), text: "hello" })
      const holder = yield* Ref.make(Option.none<ModelCallRecorder>())
      const owned = yield* makeTurnModelCallRecorder(stored.writer, (data) => Ref.get(holder).pipe(Effect.flatMap(Option.match({
        onNone: () => Effect.die("recorder was not installed"),
        onSome: (recorder) => child ? Effect.forkChild(recorder.record(data)).pipe(Effect.flatMap(Fiber.join)) : recorder.record(data),
      }))))
      yield* Ref.set(holder, Option.some(owned.recorder))
      const first = yield* owned.recorder.record(call("reentry")).pipe(Effect.exit, Effect.timeoutOption("200 millis"))
      const second = Option.isSome(first) ? yield* owned.recorder.record(call("reentry")).pipe(Effect.exit) : first
      return { first, second, stored: yield* Ref.get(stored.stored).pipe(Effect.flatMap(decode)) }
    })))
    expect(Option.isSome(observed.first)).toBe(true)
    if (Option.isSome(observed.first) && Exit.isFailure(observed.first.value)) {
      const original = Cause.squash(observed.first.value.cause)
      expect(harnessCodeOf(original)).toEqual(Option.some("events.depth"))
      expect(Exit.isExit(observed.second) && Exit.isFailure(observed.second) && Cause.squash(observed.second.cause)).toBe(original)
    }
    expect(observed.stored).toHaveLength(1)
  })

  test("captured notification ancestry cannot reject an already completed ACK", async () => {
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const stored = yield* recordingTurnWriter({ runId: RunId.make("ancestry"), text: "hello" })
      const captured = yield* Ref.make(Option.none<Context.Context<never>>())
      const owned = yield* makeTurnModelCallRecorder(stored.writer, () => Effect.context<never>().pipe(Effect.flatMap((context) => Ref.set(captured, Option.some(context)))))
      yield* owned.recorder.record(call("ancestry"))
      const context = yield* Ref.get(captured).pipe(Effect.flatMap(Effect.fromOption))
      yield* owned.recorder.record(call("ancestry")).pipe(Effect.provide(context))
      return yield* Ref.get(stored.stored).pipe(Effect.flatMap(decode))
    }))
    expect(observed).toHaveLength(1)
  })

  test("accepted facts isolate caller and observer mutation during a held ACK", async () => {
    const observed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const stored = yield* recordingTurnWriter({ runId: RunId.make("immutable"), text: "hello" })
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const values = yield* Ref.make<ReadonlyArray<number>>([])
      const writer = { ...stored.writer, flush: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))) }
      const owned = yield* makeTurnModelCallRecorder(writer, (data) => Effect.sync(() => {
        if (data.usage._tag === "Known") expect(data.usage.usage.inputTokens).toBe(1)
      }))
      yield* owned.recorder.observe?.({
        called: (data) => Effect.sync(() => {
          if (data.usage._tag === "Known") { Reflect.set(data.usage.usage, "inputTokens", 77); Reflect.set(data.usage.usage, "totalTokens", 77) }
        }), closed: () => Effect.void,
      }) ?? Effect.void
      yield* owned.recorder.observe?.({ called: (data) => {
        const usage = data.usage
        return usage._tag === "Known" ? Ref.update(values, (all) => [...all, usage.usage.inputTokens]) : Effect.void
      }, closed: () => Effect.void }) ?? Effect.void
      const tokens = { inputTokens: 1, outputTokens: 0, totalTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
      const data = { ...call("immutable"), usage: { _tag: "Known" as const, usage: tokens } }
      const recording = yield* Effect.forkChild(owned.recorder.record(data))
      yield* Deferred.await(entered)
      tokens.inputTokens = 99
      tokens.totalTokens = 99
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(recording)
      return { stored: yield* Ref.get(stored.stored).pipe(Effect.flatMap(decode)), seen: yield* Ref.get(values) }
    })))
    expect(observed.seen).toEqual([1])
    expect(observed.stored[0]?.usage).toMatchObject({ _tag: "Known", usage: { inputTokens: 1, totalTokens: 1 } })
  })
})
