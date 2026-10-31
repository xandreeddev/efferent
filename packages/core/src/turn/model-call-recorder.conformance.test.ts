import { expect, test } from "bun:test"
import { Effect, Option, Ref, Result, Semaphore } from "effect"
import type { ModelCallData } from "../domain/model-call.entity.js"
import type { ModelCallObserver } from "../ports/model-call-recorder.port.js"
import type { TurnError } from "../session/sessions.entity.js"
import { modelCallRecorderConformance } from "./model-call-recorder.conformance.js"
import type { ModelCallRecorderFixture, ModelCallRecorderSubject } from "./model-call-recorder.conformance.js"

const key = (call: ModelCallData) => JSON.stringify([call.callId, call.attempt])
const open: ModelCallRecorderSubject["open"] = (seed) => Effect.gen(function* () {
  const lock = yield* Semaphore.make(1)
  const stored = yield* Ref.make(seed.calls)
  const acknowledgments = yield* Ref.make(new Map<string, Result.Result<void, TurnError>>())
  const observers = yield* Ref.make<ReadonlyArray<ModelCallObserver>>([])
  const failure = yield* Ref.make(Option.none<TurnError>())
  const closed = yield* Ref.make(false)
  const original = new Set(seed.calls.map(key))
  const soft = (effect: Effect.Effect<void>) => effect.pipe(Effect.catchCause((cause) => Effect.logDebug("fixture observer failed", cause)))
  const recorder: ModelCallRecorderFixture["recorder"] = {
    record: (call) => lock.withPermit(Effect.gen(function* () {
      const cached = (yield* Ref.get(acknowledgments)).get(key(call))
      if (cached !== undefined) return yield* Effect.fromResult(cached)
      const nextFailure = yield* Ref.getAndSet(failure, Option.none())
      const ack = Option.match(nextFailure, { onNone: () => Result.succeed(undefined), onSome: Result.fail })
      yield* Ref.update(acknowledgments, (all) => new Map([...all, [key(call), ack]]))
      if (ack._tag === "Failure") return yield* Effect.fail(ack.failure)
      yield* Ref.update(stored, (all) => [...all, call])
      yield* Effect.forEach(yield* Ref.get(observers), (observer) => soft(observer.called(call, { replayed: false })), { concurrency: 1, discard: true })
    })),
    observe: (observer) => lock.withPermit(Effect.gen(function* () {
      yield* Ref.update(observers, (all) => [...all, observer])
      yield* Effect.forEach(yield* Ref.get(stored), (call) => soft(observer.called(call, { replayed: original.has(key(call)) })), { concurrency: 1, discard: true })
    })),
  }
  return {
    recorder, stored: Ref.get(stored), failNext: (error) => Ref.set(failure, Option.some(error)),
    close: lock.withPermit(Effect.gen(function* () {
      if (yield* Ref.getAndSet(closed, true)) return
      yield* Effect.forEach(yield* Ref.get(observers), (observer) => soft(observer.closed(seed.legacy)), { concurrency: 1, discard: true })
    })),
  }
})

const expected = ["record-durable", "terminal-once", "record-failure", "observer-bootstrap", "observer-lifetime", "observer-soft"]
test("the recorder kit passes a durable observer and pins its check list", async () => {
  const checks = modelCallRecorderConformance({ open })
  expect(checks).toHaveLength(expected.length)
  const results = await Effect.runPromise(Effect.forEach(checks, (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(results.map((result) => result._tag)).toEqual(expected.map(() => "Success"))
})

test("every recorder-kit check rejects a careless collector with no durable writes, failure propagation or observations", async () => {
  const careless: ModelCallRecorderSubject = { open: () => Effect.succeed({
    recorder: { record: () => Effect.void, observe: () => Effect.void },
    stored: Effect.succeed([]), failNext: () => Effect.void, close: Effect.void,
  }) }
  const failures = await Effect.runPromise(Effect.forEach(modelCallRecorderConformance(careless), (check) => Effect.result(check.run), { concurrency: 1 }))
  expect(failures.map((result) => result._tag === "Failure" ? result.failure.check : "passed")).toEqual(expected)
})

test.each(["erase-unknown", "wrong-model"])("record-durable catches %s", async (mode) => {
  const careless: ModelCallRecorderSubject = { open: (seed) => open(seed).pipe(Effect.map((fixture) => ({ ...fixture, recorder: {
    ...fixture.recorder, record: (call) => fixture.recorder.record(mode === "erase-unknown"
      ? { ...call, usage: { _tag: "Known", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } }
      : { ...call, model: Option.none() }),
  } }))) }
  const result = await Effect.runPromise(Effect.result(modelCallRecorderConformance(careless)[0]!.run))
  expect(result._tag === "Failure" && result.failure.check).toBe("record-durable")
})
