import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Ref, Scope } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import type { EventBody } from "../harness/session.entity.js"
import type { JournalIO } from "../ports/memory.port.js"
import { makeJournalWriter } from "./journal-writer.js"

const body = (n: number): EventBody => ({ name: `event.${n}`, data: { n } })
const numbers = (bodies: ReadonlyArray<EventBody>) => bodies.map((event) => event.data.n)

/** A store that records every call; `gate` holds the first write until released, `failOn` fails that event. */
const makeStore = (options: { readonly batched: boolean; readonly failOn?: number }) => Effect.gen(function* () {
  const stored = yield* Ref.make<ReadonlyArray<EventBody>>([])
  const calls = yield* Ref.make<ReadonlyArray<ReadonlyArray<number>>>([])
  const gate = yield* Deferred.make<void>()
  const store = (events: ReadonlyArray<EventBody>) => Deferred.await(gate).pipe(
    Effect.zipRight(Ref.update(calls, (all) => [...all, numbers(events).map(Number)])),
    Effect.zipRight(events.some((event) => event.data.n === options.failOn)
      ? Effect.fail(new HarnessError({ code: "journal.down", message: "store unavailable" }))
      : Ref.update(stored, (all) => [...all, ...events])),
  )
  const io: JournalIO = {
    append: (event) => store([event]),
    ...(options.batched ? { appendAll: store } : {}),
    read: () => Ref.get(stored),
  }
  return { io, stored, calls, release: Deferred.succeed(gate, undefined) }
})

const options = { capacity: 64, batch: 16 }

describe("the journal writer", () => {
  test("stores in offer order, writing queued appends together with appendAll", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore({ batched: true })
      const writer = yield* makeJournalWriter(store.io, yield* Effect.scope, options)
      yield* Effect.forEach([1, 2, 3, 4, 5], (n) => writer.io.append(body(n)), { discard: true })
      yield* Effect.sleep("5 millis")
      yield* Effect.forEach([6, 7, 8], (n) => writer.io.append(body(n)), { discard: true })
      yield* store.release
      yield* writer.flush
      return { stored: numbers(yield* Ref.get(store.stored)), calls: yield* Ref.get(store.calls) }
    })))
    expect(outcome.stored).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(outcome.calls.flat()).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(outcome.calls.some((call) => call.length > 1)).toBe(true)
  })

  test("without appendAll it appends one by one, still in order", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore({ batched: false })
      const writer = yield* makeJournalWriter(store.io, yield* Effect.scope, options)
      yield* Effect.forEach([1, 2, 3], (n) => writer.io.append(body(n)), { discard: true })
      yield* store.release
      yield* writer.flush
      return yield* Ref.get(store.calls)
    })))
    expect(outcome).toEqual([[1], [2], [3]])
  })

  test("flush returns once everything offered before it is stored; read flushes first", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore({ batched: true })
      yield* store.release
      const writer = yield* makeJournalWriter(store.io, yield* Effect.scope, options)
      yield* writer.io.append(body(1))
      yield* writer.io.append(body(2))
      const read = numbers(yield* writer.io.read([]))
      yield* writer.io.append(body(3))
      yield* writer.flush
      return { read, stored: numbers(yield* Ref.get(store.stored)) }
    })))
    expect(outcome).toEqual({ read: [1, 2], stored: [1, 2, 3] })
  })

  test("write runs an operation in order with the appends and returns its result", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore({ batched: true })
      const writer = yield* makeJournalWriter(store.io, yield* Effect.scope, options)
      yield* writer.io.append(body(1))
      yield* writer.io.append(body(2))
      const waiting = yield* Effect.fork(writer.write(Ref.get(store.stored).pipe(Effect.map(numbers))))
      yield* store.release
      const seenByOp = yield* waiting.await.pipe(Effect.flatten)
      const failed = yield* Effect.either(writer.write(Effect.fail("op failed" as const)))
      return { seenByOp, failed: failed._tag === "Left" ? failed.left : "none" }
    })))
    expect(outcome).toEqual({ seenByOp: [1, 2], failed: "op failed" })
  })

  test("the first failed write is latched: later appends, flush and write fail with it", async () => {
    const outcome = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const store = yield* makeStore({ batched: false, failOn: 2 })
      yield* store.release
      const writer = yield* makeJournalWriter(store.io, yield* Effect.scope, options)
      yield* Effect.forEach([1, 2, 3], (n) => writer.io.append(body(n)), { discard: true })
      const code = (either: { readonly _tag: "Left"; readonly left: unknown } | { readonly _tag: "Right" }) =>
        either._tag === "Left" && either.left instanceof HarnessError ? either.left.code : "none"
      const flushed = code(yield* Effect.either(writer.flush))
      const appended = code(yield* Effect.either(writer.io.append(body(4))))
      const written = code(yield* Effect.either(writer.write(Effect.succeed(1))))
      return { flushed, appended, written, stored: numbers(yield* Ref.get(store.stored)) }
    })))
    expect(outcome).toEqual({ flushed: "journal.down", appended: "journal.down", written: "journal.down", stored: [1] })
  })

  test("closing the scope drains what is still queued", async () => {
    const stored = await Effect.runPromise(Effect.gen(function* () {
      const store = yield* makeStore({ batched: true })
      const scope = yield* Scope.make()
      const writer = yield* makeJournalWriter(store.io, scope, options)
      yield* Effect.forEach([1, 2, 3], (n) => writer.io.append(body(n)), { discard: true })
      yield* Effect.fork(Effect.sleep("5 millis").pipe(Effect.zipRight(store.release)))
      yield* Scope.close(scope, Exit.void)
      return numbers(yield* Ref.get(store.stored))
    }))
    expect(stored).toEqual([1, 2, 3])
  })
})
