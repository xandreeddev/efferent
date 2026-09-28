import { Deferred, Effect, Option, Queue, Ref, Scope } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { EventBody } from "../harness/session.entity.js"
import type { JournalIO, JournalWriter } from "../ports/memory.port.js"

/** One queued piece of work, stored in queue order. */
type Item =
  | { readonly _tag: "Append"; readonly events: ReadonlyArray<EventBody> }
  | { readonly _tag: "Run"; readonly run: Effect.Effect<void> }
  | { readonly _tag: "Marker"; readonly done: Deferred.Deferred<void, HarnessError> }

export interface JournalWriterOptions {
  /** Queued items before an append waits for the writer. */
  readonly capacity: number
  /** The most items the writer takes at once; consecutive appends among them are written together. */
  readonly batch: number
}

/** Consecutive appends merged into one group; other items stay where they are. */
const groupsOf = (items: ReadonlyArray<Item>): ReadonlyArray<Item> => items.reduce((groups: ReadonlyArray<Item>, item): ReadonlyArray<Item> => {
  const last = groups.at(-1)
  return last?._tag === "Append" && item._tag === "Append"
    ? [...groups.slice(0, -1), { _tag: "Append", events: [...last.events, ...item.events] }]
    : [...groups, item]
}, [])

/**
 * The turn's ordered write-behind journal. Producers queue and go on; one
 * writer fiber, forked in `scope`, stores items strictly in queue order and
 * writes consecutive appends with `appendAll` when the store has it. The
 * first failed write is latched: later appends are refused, `flush` and
 * `write` fail with it, so the turn fails at its next journal touch. Closing
 * the scope drains the queue first.
 */
export const makeJournalWriter = (journal: JournalIO, scope: Scope.Scope, options: JournalWriterOptions): Effect.Effect<JournalWriter> => Effect.gen(function* () {
  const queue = yield* Queue.bounded<Item>(options.capacity)
  const failed = yield* Ref.make(Option.none<HarnessError>())

  const store = (events: ReadonlyArray<EventBody>): Effect.Effect<void, HarnessError> =>
    journal.appendAll === undefined || events.length === 1
      ? Effect.forEach(events, journal.append, { discard: true })
      : journal.appendAll(events)

  const process = (item: Item): Effect.Effect<void> => Ref.get(failed).pipe(Effect.flatMap((failure) => {
    if (item._tag === "Marker") return Option.match(failure, { onNone: () => Deferred.succeed(item.done, undefined), onSome: (error) => Deferred.fail(item.done, error) }).pipe(Effect.asVoid)
    if (item._tag === "Run") return item.run
    return Option.isSome(failure) ? Effect.void : store(item.events).pipe(Effect.catch((error) => Ref.set(failed, Option.some(error))))
  }))

  const writer = Queue.takeBetween(queue, 1, options.batch).pipe(
    Effect.flatMap((chunk) => Effect.forEach(groupsOf(chunk), process, { discard: true })),
    Effect.forever,
  )
  yield* Effect.forkIn(writer, scope)

  const refuseAfterFailure = Ref.get(failed).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Effect.fail })))
  const enqueue = (events: ReadonlyArray<EventBody>) => refuseAfterFailure.pipe(
    Effect.andThen(events.length === 0 ? Effect.void : Queue.offer(queue, { _tag: "Append", events }).pipe(Effect.asVoid)),
  )
  const flush: Effect.Effect<void, HarnessError> = Deferred.make<void, HarnessError>().pipe(Effect.flatMap((done) =>
    Queue.offer(queue, { _tag: "Marker", done }).pipe(Effect.andThen(Deferred.await(done)))))

  const write = <A, E>(op: Effect.Effect<A, E>): Effect.Effect<A, E | HarnessError> => Effect.gen(function* () {
    const result = yield* Deferred.make<A, E | HarnessError>()
    const run = Ref.get(failed).pipe(Effect.flatMap(Option.match({
      onNone: () => Effect.exit(op).pipe(Effect.flatMap((exit) => Deferred.done(result, exit))),
      onSome: (error) => Deferred.fail(result, error),
    })), Effect.asVoid)
    yield* Queue.offer(queue, { _tag: "Run", run })
    return yield* Deferred.await(result)
  })

  // Runs before the writer fiber is interrupted (finalizers run last-added first): nothing queued is dropped.
  yield* Scope.addFinalizer(scope, flush.pipe(Effect.timeout("10 seconds"), Effect.ignore))

  return {
    io: {
      append: (event) => enqueue([event]),
      appendAll: enqueue,
      read: (names) => flush.pipe(Effect.andThen(journal.read(names))),
    },
    flush,
    write,
  }
})
