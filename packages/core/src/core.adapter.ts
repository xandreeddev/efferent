import { Cause, Effect, Fiber, Layer, Option, PubSub, Ref, Stream } from "effect"
import type { Schema } from "effect"
import { Core } from "./core.port.js"
import type { ListenOptions, PublishOptions } from "./core.port.js"
import { dataOf, reasonOf } from "./event.entity.functions.js"
import { ListenerFailed } from "./event.entity.js"
import type { DeliveryOf, EventDefinition, KernelEvent } from "./event.entity.js"
import type { EventName } from "./ids.entity.js"
import { listenerFailed } from "./vocabulary.entity.functions.js"
import { listenerFailedEvent } from "./vocabulary.entity.js"

/**
 * How an agent's kernel is set up: how `Core` delivers events, and
 * nothing of a workflow.
 *
 * @public
 */
export interface KernelOptions {
  /** How many events background delivery holds for a reader that is behind, before it loses the oldest. 256 when left out. */
  readonly capacity?: number
}

const DEFAULT_CAPACITY = 256

/** A listener the publisher waits for, in the order it registered. */
interface Waiting {
  readonly key: number
  readonly event: EventName
  readonly run: (event: KernelEvent) => Effect.Effect<void, ListenerFailed>
}

/**
 * `Core` in one process: the waiting listeners in a list, in the order
 * they registered, and one bounded sliding hub for the background
 * listeners and the host's stream. A reader that falls more than
 * `capacity` events behind loses the oldest ones.
 *
 * A listener runs on a fiber of its own. Whoever waits for it stops
 * waiting the moment its own wait is interrupted, whether or not the
 * listener can be interrupted: so a limit put on a publish, and the close
 * of a scope, hold at their own time, and a listener cut short is reported
 * by the one who stopped waiting.
 */
export const makeCore = Effect.fnUntraced(function* (options: KernelOptions = {}) {
  const hub = yield* Effect.acquireRelease(PubSub.sliding<KernelEvent>(options.capacity ?? DEFAULT_CAPACITY), PubSub.shutdown)
  const waiting = yield* Ref.make<ReadonlyArray<Waiting>>([])
  const keys = yield* Ref.make(0)
  const nextKey = Ref.getAndUpdate(keys, (next) => next + 1)

  const hand = (event: KernelEvent) => PubSub.publish(hub, event)

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
      // Started at once, so a listener that does not suspend is done before anything else runs, as if it were called in place.
      const fiber = yield* Effect.forkDetach(run, { startImmediately: true })
      return yield* restore(Fiber.join(fiber)).pipe(
        Effect.onInterrupt(() => Effect.andThen(cut, Effect.forkDetach(Fiber.interrupt(fiber)))),
      )
    }))

  /** Run a waiting listener, unless its scope closed since the publish began. */
  const stillWaiting = (listener: Waiting, event: KernelEvent) =>
    Effect.flatMap(Ref.get(waiting), (now) => now.some((entry) => entry.key === listener.key) ? listener.run(event) : Effect.void)

  // Waiting listeners first, in registration order; then the publisher's own step; then the hub, whatever they did, so
  // the stream shows what the journal holds. A reader of the hub hears of the event only once it was handed over. By
  // default the first failure stops the waiting listeners after it and fails the publish; told to report, every one runs,
  // and each failure is reported after the hand-over, in the order the listeners ran.
  function publish(event: KernelEvent, options: PublishOptions & { readonly listenerFailures: "report" }): Effect.Effect<void>
  function publish(event: KernelEvent, options?: PublishOptions): Effect.Effect<void, ListenerFailed>
  function publish(event: KernelEvent, options?: PublishOptions): Effect.Effect<void, ListenerFailed> {
    const reporting = options?.listenerFailures === "report"
    return Effect.flatMap(Ref.make<ReadonlyArray<ListenerFailed>>([]), (failed) => {
      const run = (listener: Waiting) => reporting
        ? stillWaiting(listener, event).pipe(Effect.catchTag("ListenerFailed", (failure) => Ref.update(failed, (all) => [...all, failure])))
        : stillWaiting(listener, event)
      return Effect.uninterruptibleMask((restore) => restore(Ref.get(waiting).pipe(
        Effect.flatMap((listeners) => Effect.forEach(listeners.filter((listener) => listener.event === event.name), run, { concurrency: 1, discard: true })),
      )).pipe(
        Effect.ensuring(options?.beforeHandOver ?? Effect.void),
        Effect.ensuring(hand(event)),
        Effect.ensuring(Effect.flatMap(Ref.get(failed), (all) => Effect.forEach(all, (failure) => report(event, failure), { concurrency: 1, discard: true }))),
      ))
    })
  }

  const on = Effect.fnUntraced(function* <Definition extends EventDefinition<Schema.Json>, E>(definition: Definition, handler: (event: DeliveryOf<Definition>) => Effect.Effect<void, E>, options: ListenOptions) {
    const listener = options.name
    // An event is the definition's when it has its name and its kind: a live event published under a stored
    // definition's name is not a record, and a handler written for records is not given it.
    const ofDefinition = (event: KernelEvent) => event.name === definition.name && (event._tag === "Stored") === (definition.kind === "stored")
    const failed = (event: KernelEvent, message: string, cause?: unknown) =>
      new ListenerFailed({ listener, event: event.name, message, ...(cause === undefined ? {} : { cause }) })
    const run = (event: KernelEvent): Effect.Effect<void, ListenerFailed> =>
      Option.match(dataOf(definition, event), {
        onNone: () => Effect.fail(failed(event, "the event's data is not what the listener's definition describes")),
        // Whatever the handler ends with is its own failure, an interrupt it was not sent included (`Effect.interrupt`,
        // a join of an interrupted fiber): only the interruption of whoever waits for it is the cut, and `call` sees that.
        onSome: (data): Effect.Effect<void, ListenerFailed> => handler({ ...event, data } as DeliveryOf<Definition>).pipe(
          Effect.catchCause((cause) => Effect.fail(failed(event, reasonOf(cause), Cause.squash(cause)))),
        ),
      })
    const key = yield* nextKey
    // `core.listener.failed` is never waited for: a report must not be held by the listeners it is for.
    if (options.wait === true && definition.name !== listenerFailedEvent.name) {
      // A waiting listener cut short is reported by name, by the publisher that stopped waiting: it was interrupted, or its limit ran out.
      const waited = (event: KernelEvent) => ofDefinition(event) ? call(listener, event, run(event), report(event, failed(event, "interrupted before it finished"))) : Effect.void
      yield* Effect.acquireRelease(
        Ref.update(waiting, (all) => [...all, { key, event: definition.name, run: waited }]),
        () => Ref.update(waiting, (all) => all.filter((entry) => entry.key !== key)),
      )
      return
    }
    // Subscribed before `on` returns, so the listener misses nothing published after it.
    const subscription = yield* PubSub.subscribe(hub)
    // Its scope's close stops the wait for a call under way, and the call behind it: no report, the listener is going.
    yield* Effect.forkScoped(Effect.forever(PubSub.take(subscription).pipe(
      Effect.flatMap((next) => ofDefinition(next)
        ? call(listener, next, run(next), Effect.void).pipe(Effect.catchTag("ListenerFailed", (failure) => report(next, failure)))
        : Effect.void),
    )))
  })

  return Core.of({ publish, on, events: Stream.fromPubSub(hub) })
})

/**
 * The kernel of an agent, as a layer: `Core`, the events of the agent in
 * one process, and nothing else. Every other part is a layer of its own,
 * composed over this one: sessions and their storage, and every workflow.
 *
 * @public
 */
export const kernel = (options: KernelOptions = {}): Layer.Layer<Core> => Layer.effect(Core, makeCore(options))
