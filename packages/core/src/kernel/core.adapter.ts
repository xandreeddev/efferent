import { Cause, Effect, Layer, Option, PubSub, Ref, Stream } from "effect"
import type { Schema } from "effect"
import { Core, CurrentPlugin } from "./core.port.js"
import type { ListenOptions } from "./core.port.js"
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
 */
export const makeCore = Effect.fnUntraced(function* (options: CoreOptions = {}) {
  const hub = yield* Effect.acquireRelease(PubSub.sliding<KernelEvent>(options.capacity ?? DEFAULT_CAPACITY), PubSub.shutdown)
  const waiting = yield* Ref.make<ReadonlyArray<Waiting>>([])
  const keys = yield* Ref.make(0)

  /** Run a waiting listener, unless its scope closed since the publish began. */
  const stillWaiting = (listener: Waiting, event: KernelEvent) =>
    Effect.flatMap(Ref.get(waiting), (now) => now.some((entry) => entry.key === listener.key) ? listener.run(event) : Effect.void)

  // Waiting listeners first, in registration order; then the hub, whatever they did, so the stream shows what the journal holds.
  const publish = (event: KernelEvent): Effect.Effect<void, ListenerFailed> =>
    Ref.get(waiting).pipe(
      Effect.flatMap((listeners) => Effect.forEach(listeners.filter((listener) => listener.event === event.name), (listener) => stillWaiting(listener, event), { concurrency: 1, discard: true })),
      Effect.ensuring(PubSub.publish(hub, event)),
    )

  // A failure nobody can fail for becomes `core.listener.failed`, handed to the hub and waited for by nobody: no
  // listener can hold the report. A listener of that event that fails is logged, never reported again.
  const report = (event: KernelEvent, failure: ListenerFailed): Effect.Effect<void> =>
    event.name === listenerFailedEvent.name
      ? Effect.logWarning(`a listener of ${event.name} failed`, failure.listener, failure.message)
      : Effect.asVoid(PubSub.publish(hub, listenerFailed(event, failure)))

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
    // `core.listener.failed` is never waited for: a report must not be held by the listeners it is for.
    if (options?.wait === true && definition.name !== listenerFailedEvent.name) {
      const key = yield* Ref.getAndUpdate(keys, (next) => next + 1)
      // A waiting listener cut short is reported by name: its publisher was interrupted, or stopped waiting.
      const waited = (event: KernelEvent) => run(event).pipe(Effect.onInterrupt(() => report(event, failed(event, "interrupted before it finished"))))
      yield* Effect.acquireRelease(
        Ref.update(waiting, (all) => [...all, { key, event: definition.name, run: waited }]),
        () => Ref.update(waiting, (all) => all.filter((entry) => entry.key !== key)),
      )
      return
    }
    // Subscribed before `on` returns, so the listener misses nothing published after it.
    const subscription = yield* PubSub.subscribe(hub)
    yield* Effect.forkScoped(Effect.forever(PubSub.take(subscription).pipe(
      Effect.flatMap((event) => event.name === definition.name ? run(event).pipe(Effect.catchTag("ListenerFailed", (failure) => report(event, failure))) : Effect.void),
    )))
  })

  return Core.of({ publish, on, events: Stream.fromPubSub(hub) })
})

/** `Core` as a layer: the events of one agent, in one process. */
export const CoreLive = (options?: CoreOptions) => Layer.effect(Core, makeCore(options))
