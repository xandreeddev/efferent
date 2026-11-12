import { Cause, Context, Deferred, Effect, Fiber, Layer, Option, PubSub, Ref, Stream } from "effect"
import type { Duration, Schema } from "effect"
import { Core, CoreIdle, CurrentPlugin } from "./core.port.js"
import type { ListenOptions, PublishOptions } from "./core.port.js"
import { dataOf, reasonOf } from "./event.entity.functions.js"
import { ListenerFailed } from "./event.entity.js"
import type { Delivered, EventDefinition, KernelEvent } from "./event.entity.js"
import type { EventName } from "./ids.entity.js"
import { listenerFailed } from "./vocabulary.entity.functions.js"
import { listenerFailedEvent } from "./vocabulary.entity.js"

/** How `Core` is set up. */
export interface CoreOptions {
  /** How many events background delivery holds for a reader that is behind, before it loses the oldest. 256 when left out. */
  readonly capacity?: number
  /**
   * How long `CoreIdle.wait` gives the listeners to handle what was
   * published. A listener still running after that long is reported as
   * `core.listener.failed` and waited for no longer. 5 seconds when left out.
   */
  readonly idleWait?: Duration.Input
}

const DEFAULT_CAPACITY = 256
const DEFAULT_IDLE_WAIT: Duration.Input = "5 seconds"

/** A listener the publisher waits for, in the order it registered. */
interface Waiting {
  readonly key: number
  readonly event: EventName
  readonly run: (event: KernelEvent) => Effect.Effect<void, ListenerFailed>
}

/** A place in the hub's order that every background listener acknowledges when it reaches it: everything before it was handled. */
interface Mark {
  readonly _tag: "Mark"
  readonly id: number
}
/** What the hub hands over: an event, or a mark. A mark never reaches `events`. */
type Handed = KernelEvent | Mark
const isMark = (handed: Handed): handed is Mark => handed._tag === "Mark"
const isEvent = (handed: Handed): handed is KernelEvent => handed._tag !== "Mark"

/** The publishes under way, and who waits for there to be none. */
interface Flights {
  readonly under: number
  readonly waiters: ReadonlyArray<Deferred.Deferred<void>>
}
/** The listeners that read the hub, and the marks they have not all reached yet. */
interface Readers {
  readonly listeners: ReadonlyMap<number, string>
  readonly marks: ReadonlyArray<{ readonly id: number; readonly pending: ReadonlySet<number>; readonly reached: Deferred.Deferred<void> }>
}

const settle = (all: ReadonlyArray<Deferred.Deferred<void>>) =>
  Effect.forEach(all, (one) => Deferred.succeed(one, undefined), { concurrency: 1, discard: true })

/**
 * `Core` in one process: the waiting listeners in a list, in the order
 * they registered, and one bounded sliding hub for the background
 * listeners and the host's stream. A reader that falls more than
 * `capacity` events behind loses the oldest ones. With it, the wait for the
 * listeners to have handled everything published (`CoreIdle`).
 *
 * A listener runs on a fiber of its own. Whoever waits for it stops
 * waiting the moment its own wait is interrupted, whether or not the
 * listener can be interrupted: so a limit put on a publish, and the close
 * of a scope, hold at their own time, and a listener cut short is reported
 * by the one who stopped waiting.
 */
const makeBus = Effect.fnUntraced(function* (options: CoreOptions = {}) {
  const hub = yield* Effect.acquireRelease(PubSub.sliding<Handed>(options.capacity ?? DEFAULT_CAPACITY), PubSub.shutdown)
  const waiting = yield* Ref.make<ReadonlyArray<Waiting>>([])
  const keys = yield* Ref.make(0)
  const flights = yield* Ref.make<Flights>({ under: 0, waiters: [] })
  const readers = yield* Ref.make<Readers>({ listeners: new Map(), marks: [] })
  /** How many events were handed to the hub: a wait that saw the count move is not over. */
  const handed = yield* Ref.make(0)
  /** The listener calls somebody is waiting for now, with the event each is handling. */
  const running = yield* Ref.make<ReadonlyMap<number, { readonly listener: string; readonly event: KernelEvent }>>(new Map())
  const nextKey = Ref.getAndUpdate(keys, (next) => next + 1)

  const hand = (event: KernelEvent) => Effect.andThen(Ref.update(handed, (count) => count + 1), PubSub.publish(hub, event))

  // A failure nobody can fail for becomes `core.listener.failed`, handed to the hub and waited for by nobody: no
  // listener can hold the report. A listener of that event that fails is logged, never reported again.
  const report = (event: KernelEvent, failure: ListenerFailed): Effect.Effect<void> =>
    event.name === listenerFailedEvent.name
      ? Effect.logWarning(`a listener of ${event.name} failed`, failure.listener, failure.message)
      : Effect.asVoid(hand(listenerFailed(event, failure)))

  /**
   * Call a listener on a fiber of its own and wait for it. When the wait is
   * interrupted it returns at once, whatever the listener is doing: `cut`
   * runs, and the listener is interrupted behind the one who waited.
   */
  const call = (listener: string, event: KernelEvent, run: Effect.Effect<void, ListenerFailed>, cut: Effect.Effect<void>) =>
    Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const key = yield* nextKey
      yield* Ref.update(running, (all) => new Map([...all, [key, { listener, event }]]))
      // Started at once, so a listener that does not suspend is done before anything else runs, as if it were called in place.
      const fiber = yield* Effect.forkDetach(run, { startImmediately: true })
      return yield* restore(Fiber.join(fiber)).pipe(
        Effect.onInterrupt(() => Effect.andThen(cut, Effect.forkDetach(Fiber.interrupt(fiber)))),
        Effect.ensuring(Ref.update(running, (all) => new Map(Array.from(all).filter(([other]) => other !== key)))),
      )
    }))

  /** Run a waiting listener, unless its scope closed since the publish began. */
  const stillWaiting = (listener: Waiting, event: KernelEvent) =>
    Effect.flatMap(Ref.get(waiting), (now) => now.some((entry) => entry.key === listener.key) ? listener.run(event) : Effect.void)

  const takeOff = Ref.update(flights, (now) => ({ ...now, under: now.under + 1 }))
  const land = Ref.modify(flights, (now): readonly [Effect.Effect<void>, Flights] => now.under <= 1
    ? [settle(now.waiters), { under: 0, waiters: [] }]
    : [Effect.void, { ...now, under: now.under - 1 }]).pipe(Effect.flatten)

  // Waiting listeners first, in registration order; then the publisher's own step; then the hub, whatever they did, so
  // the stream shows what the journal holds. A reader of the hub runs as the event is handed to it, before this returns.
  const publish = (event: KernelEvent, options?: PublishOptions): Effect.Effect<void, ListenerFailed> =>
    Effect.uninterruptibleMask((restore) => Effect.andThen(takeOff, restore(Ref.get(waiting).pipe(
      Effect.flatMap((listeners) => Effect.forEach(listeners.filter((listener) => listener.event === event.name), (listener) => stillWaiting(listener, event), { concurrency: 1, discard: true })),
    )).pipe(
      Effect.ensuring(options?.beforeHandOver ?? Effect.void),
      Effect.ensuring(hand(event)),
      Effect.ensuring(land),
    )))

  /** A background listener reached a mark, or left: the mark is reached once nobody is pending. */
  const acknowledge = (listener: number, only?: number) => Ref.modify(readers, (now): readonly [Effect.Effect<void>, Readers] => {
    const marks = now.marks.map((mark) => only === undefined || mark.id === only
      ? { ...mark, pending: new Set(Array.from(mark.pending).filter((other) => other !== listener)) }
      : mark)
    return [settle(marks.filter((mark) => mark.pending.size === 0).map((mark) => mark.reached)), { ...now, marks: marks.filter((mark) => mark.pending.size > 0) }]
  }).pipe(Effect.flatten)

  const on = Effect.fnUntraced(function* <D extends Schema.Json, E>(definition: EventDefinition<D>, handler: (event: Delivered<D>) => Effect.Effect<void, E>, options?: ListenOptions) {
    const listener = options?.name ?? (yield* CurrentPlugin)
    const failed = (event: KernelEvent, message: string, cause?: unknown) =>
      new ListenerFailed({ listener, event: event.name, message, ...(cause === undefined ? {} : { cause }) })
    const run = (event: KernelEvent): Effect.Effect<void, ListenerFailed> =>
      Option.match(dataOf(definition, event), {
        onNone: () => Effect.fail(failed(event, "the event's data is not what the listener's definition describes")),
        onSome: (data): Effect.Effect<void, ListenerFailed> => handler({ ...event, data }).pipe(
          Effect.catchCause((cause): Effect.Effect<never, ListenerFailed> =>
            Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.fail(failed(event, reasonOf(cause), Cause.squash(cause)))),
        ),
      })
    const key = yield* nextKey
    // `core.listener.failed` is never waited for: a report must not be held by the listeners it is for.
    if (options?.wait === true && definition.name !== listenerFailedEvent.name) {
      // A waiting listener cut short is reported by name, by the publisher that stopped waiting: it was interrupted, or its limit ran out.
      const waited = (event: KernelEvent) => call(listener, event, run(event), report(event, failed(event, "interrupted before it finished")))
      yield* Effect.acquireRelease(
        Ref.update(waiting, (all) => [...all, { key, event: definition.name, run: waited }]),
        () => Ref.update(waiting, (all) => all.filter((entry) => entry.key !== key)),
      )
      return
    }
    // Subscribed before `on` returns, so the listener misses nothing published after it.
    const subscription = yield* PubSub.subscribe(hub)
    yield* Effect.acquireRelease(
      Ref.update(readers, (now) => ({ ...now, listeners: new Map([...now.listeners, [key, listener]]) })),
      () => Effect.andThen(Ref.update(readers, (now) => ({ ...now, listeners: new Map(Array.from(now.listeners).filter(([other]) => other !== key)) })), acknowledge(key)),
    )
    // Its scope's close stops the wait for a call under way, and the call behind it: no report, the listener is going.
    yield* Effect.forkScoped(Effect.forever(PubSub.take(subscription).pipe(
      Effect.flatMap((next) => isMark(next) ? acknowledge(key, next.id)
        : next.name === definition.name ? call(listener, next, run(next), Effect.void).pipe(Effect.catchTag("ListenerFailed", (failure) => report(next, failure)))
        : Effect.void),
    )))
  })

  /** No publish is under way: every waiting listener of every event published so far is done, or was cut. */
  const landed = Effect.flatMap(Deferred.make<void>(), (ready) => Ref.modify(flights, (now): readonly [Effect.Effect<void>, Flights] => now.under === 0
    ? [Effect.void, now]
    : [Deferred.await(ready), { ...now, waiters: [...now.waiters, ready] }]).pipe(Effect.flatten))

  /** Every background listener has handled what the hub held when this began. */
  const caughtUp = Effect.gen(function* () {
    const id = yield* nextKey
    const reached = yield* Deferred.make<void>()
    const asked = yield* Ref.modify(readers, (now): readonly [boolean, Readers] => now.listeners.size === 0
      ? [false, now]
      : [true, { ...now, marks: [...now.marks, { id, pending: new Set(now.listeners.keys()), reached }] }])
    if (!asked) return
    yield* PubSub.publish(hub, { _tag: "Mark", id })
    yield* Deferred.await(reached).pipe(Effect.ensuring(Ref.update(readers, (now) => ({ ...now, marks: now.marks.filter((mark) => mark.id !== id) }))))
  })

  /** One pass: the background caught up, and no publish under way. Quiet when nothing was handed over meanwhile. */
  const pass = Effect.gen(function* () {
    const before = yield* Ref.get(handed)
    yield* caughtUp
    yield* landed
    return (yield* Ref.get(handed)) === before
  })
  const quiet: Effect.Effect<void> = Effect.flatMap(pass, (still) => still ? Effect.void : Effect.suspend(() => quiet))

  /** What is still running when the wait gives up, reported and waited for no longer. */
  const reportRunning = Effect.flatMap(Ref.get(running), (all) => Effect.forEach(
    Array.from(all.values()),
    ({ listener, event }) => report(event, new ListenerFailed({ listener, event: event.name, message: "still running when the wait for the listeners ended" })),
    { concurrency: 1, discard: true },
  ))

  const idle = CoreIdle.of({
    wait: quiet.pipe(
      Effect.timeoutOption(options.idleWait ?? DEFAULT_IDLE_WAIT),
      Effect.flatMap(Option.match({ onSome: () => Effect.void, onNone: () => reportRunning })),
    ),
  })

  return { core: Core.of({ publish, on, events: Stream.filter(Stream.fromPubSub(hub), isEvent) }), idle }
})

/** `Core` alone, for a kit or a test that needs no agent around it. */
export const makeCore = Effect.fnUntraced(function* (options: CoreOptions = {}) {
  return (yield* makeBus(options)).core
})

/** `Core` as a layer, the events of one agent in one process, with `CoreIdle`, the wait the agent's wiring uses to replace an agent. */
export const CoreLive = (options?: CoreOptions) =>
  Layer.effectContext(Effect.map(makeBus(options), ({ core, idle }) => Context.make(Core, core).pipe(Context.add(CoreIdle, idle))))
