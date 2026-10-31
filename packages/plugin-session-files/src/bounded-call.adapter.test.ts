import { expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { makeBoundedFilesCall } from "./bounded-call.adapter.js"

const gate = <A>() => {
  const callbacks: { resolve?: (value: A) => void; reject?: (cause: unknown) => void } = {}
  const promise = new Promise<A>((resolve, reject) => { callbacks.resolve = resolve; callbacks.reject = reject })
  return { promise, resolve: (value: A) => callbacks.resolve!(value), reject: (cause: unknown) => callbacks.reject!(cause) }
}

test("timed-out native operations retain both slots across cooldown probes and release on settlement", async () => {
  const pending: ReturnType<typeof gate<number>>[] = []
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const call = yield* makeBoundedFilesCall(30)
    yield* Effect.forEach([0, 1, 2], () => Effect.gen(function* () {
      const result = yield* Effect.result(call("read", "held", () => { const next = gate<number>(); pending.push(next); return next.promise }))
      expect(result._tag === "Failure" && result.failure._tag).toBe("FileStoreStalled")
      yield* Effect.sleep(35)
    }), { concurrency: 1 })
    expect(pending).toHaveLength(2)
    pending[0]!.resolve(1)
    yield* Effect.sleep(1)
    expect(yield* call("read", "recovered", () => Promise.resolve(3))).toBe(3)
  })).pipe(Effect.ensuring(Effect.sync(() => pending.forEach(item => item.resolve(0)))), Effect.timeout("2 seconds")))
})

test("healthy calls queue and cancellation preserves native slots without hanging scope cleanup", async () => {
  const pending: ReturnType<typeof gate<number>>[] = []
  const started = gate<void>()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const call = yield* makeBoundedFilesCall(100)
    const run = () => { const next = gate<number>(); pending.push(next); if (pending.length === 2) started.resolve(undefined); return next.promise }
    const first = yield* Effect.forkChild(call("read", "one", run))
    const second = yield* Effect.forkChild(call("read", "two", run))
    yield* Effect.tryPromise(() => started.promise)
    const third = yield* Effect.forkChild(call("read", "queued", run))
    yield* Fiber.interrupt(third)
    yield* Fiber.interrupt(first)
    yield* Fiber.interrupt(second)
    yield* Effect.sleep(110)
    const blocked = yield* Effect.result(call("read", "full", run))
    expect(blocked._tag === "Failure" && blocked.failure._tag).toBe("FileStoreStalled")
    expect(pending).toHaveLength(2)
  })).pipe(Effect.ensuring(Effect.sync(() => pending.forEach(item => item.resolve(0)))), Effect.timeout("2 seconds")))
})

test("native factory throws preserve cause identity and late rejection is observed after interruption", async () => {
  const original = new Error("native factory failed")
  const late = gate<number>()
  const entered = gate<void>()
  const unhandled: unknown[] = []
  const notice = (cause: unknown) => { unhandled.push(cause) }
  process.on("unhandledRejection", notice)
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const call = yield* makeBoundedFilesCall(30)
    const result = yield* Effect.result(call("read", "reject", () => Promise.reject(original)))
    expect(result._tag === "Failure" && result.failure._tag === "FileStoreIo" && result.failure.cause).toBe(original)
    const thrown = yield* Effect.result(call("read", "throw", () => Promise.resolve(Reflect.apply(Uint8Array.prototype.slice, {}, []))))
    expect(thrown._tag === "Failure" && thrown.failure._tag === "FileStoreIo" && thrown.failure.cause instanceof TypeError).toBe(true)
    const fiber = yield* Effect.forkChild(call("read", "late", () => { entered.resolve(undefined); return late.promise }))
    yield* Effect.tryPromise(() => entered.promise)
    yield* Fiber.interrupt(fiber)
    late.reject(original)
    yield* Effect.sleep(35)
    expect(unhandled).toEqual([])
    expect(yield* call("read", "later", () => Promise.resolve(4))).toBe(4)
  })).pipe(Effect.ensuring(Effect.sync(() => process.off("unhandledRejection", notice))), Effect.timeout("2 seconds")))
})

test("healthy requests wait their turn and all complete with at most two native operations", async () => {
  const active = { count: 0, maximum: 0 }
  const results = await Effect.runPromise(Effect.gen(function* () {
    const call = yield* makeBoundedFilesCall(100)
    return yield* Effect.forEach([0, 1, 2, 3, 4, 5], value => call("read", "healthy", () => new Promise<number>(resolve => {
      active.count++
      active.maximum = Math.max(active.maximum, active.count)
      setTimeout(() => { active.count--; resolve(value) }, 2)
    })), { concurrency: 6 })
  }))
  expect(results).toEqual([0, 1, 2, 3, 4, 5])
  expect(active.maximum).toBe(2)
})

test("interrupting a cooldown probe clears the probing phase and later calls recover", async () => {
  const first = gate<number>()
  const probe = gate<number>()
  const entered = gate<void>()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const call = yield* makeBoundedFilesCall(30)
    yield* Effect.result(call("read", "timeout", () => first.promise))
    first.resolve(0)
    yield* Effect.sleep(35)
    const fiber = yield* Effect.forkChild(call("read", "probe", () => { entered.resolve(undefined); return probe.promise }))
    yield* Effect.tryPromise(() => entered.promise)
    yield* Fiber.interrupt(fiber)
    probe.resolve(0)
    yield* Effect.sleep(35)
    expect(yield* call("read", "recovery", () => Promise.resolve(5))).toBe(5)
  })).pipe(Effect.ensuring(Effect.sync(() => { first.resolve(0); probe.resolve(0) })), Effect.timeout("2 seconds")))
})

test("logical admission expires without starting queued IO or disturbing answered native calls", async () => {
  const entered = gate<void>()
  const release = gate<number>()
  const starts: number[] = []
  const results = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const call = yield* makeBoundedFilesCall(500)
    const fiber = yield* Effect.forkChild(Effect.forEach([0, 1, 2, 3, 4, 5], value => Effect.result(call("read", "queue", () => {
      starts.push(value)
      if (starts.length === 2) entered.resolve(undefined)
      return release.promise
    })), { concurrency: 6 }))
    yield* Effect.tryPromise(() => entered.promise)
    yield* TestClock.adjust(500)
    release.resolve(1)
    return yield* Fiber.join(fiber)
  })).pipe(Effect.provide(TestClock.layer()), Effect.ensuring(Effect.sync(() => release.resolve(1)))))
  expect(starts).toHaveLength(2)
  expect(results.filter(result => result._tag === "Success")).toHaveLength(2)
  expect(results.filter(result => result._tag === "Failure" && result.failure._tag === "FileStoreStalled")).toHaveLength(4)
})
