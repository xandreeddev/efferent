import { Cause, Context, Deferred, Effect, Fiber, Option, Queue, Ref, Semaphore } from "effect"
import type { Scope } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import { isHarnessError } from "../harness/plugin.entity.functions.js"
import { CurrentTraceContent, replayableContext } from "../loop/traceContent.js"
import type { SubscribeOptions, TurnEventsService, TurnTasksService } from "../ports/turn-events.port.js"
import type { TurnEvent } from "./turn-event.entity.js"
import { randomUuid } from "../util/random-id.js"

interface Subscriber {
  readonly id: number
  readonly deliver: (event: TurnEvent) => Effect.Effect<void, HarnessError>
  /** Background subscriptions: wait until everything queued so far is handled. */
  readonly drain: Effect.Effect<void, HarnessError>
}

/** One queued delivery (`roomed`: it took a place of the lane's capacity), or a marker the drain waits on. */
type Queued<E> =
  | { readonly _tag: "Event"; readonly event: E; readonly depth: number; readonly traceContent: boolean; readonly roomed: boolean }
  | { readonly _tag: "Marker"; readonly done: Deferred.Deferred<void, HarnessError> }

/**
 * A background handler's failure as the turn fails with it: its typed error,
 * or a HarnessError it carried as a defect, as a failure; any other defect
 * stays the defect it is; an interruption alone fails with `events.background`.
 */
const failureOf = (cause: Cause.Cause<HarnessError>): Cause.Cause<HarnessError> => Option.match(Cause.findErrorOption(cause), {
  onSome: Cause.fail,
  onNone: () => {
    const defect = Cause.squash(cause)
    return isHarnessError(defect) ? Cause.fail(defect)
      : Cause.hasInterruptsOnly(cause) ? Cause.fail(new HarnessError({ code: "events.background", message: "a background handler was interrupted" }))
      : cause
  },
})

const defaultCapacity = 256

/**
 * An ordered event bus. `publish` runs every inline subscriber in
 * subscription order before it returns; a handler may publish in turn
 * (depth-first) up to `maxDepth`, which catches reaction cycles. Background
 * subscribers get the event on their own queue and handle it in order on
 * their own fiber; `drain` waits for them. A publisher waits while a
 * background queue is full, except a background handler of this bus (of any
 * subscription, and what it runs inline): its publications are queued past
 * the capacity, since the queue it would wait on may be its own, or one
 * whose handler waits on it, and only that lane's fiber takes from it; its
 * reaction chains stay bounded by `maxDepth`. A publisher waiting for room
 * can always be interrupted. `activity` counts background deliveries so
 * far, so a caller can tell whether a drain left new work.
 */
export const makeTurnEvents = (options: { readonly maxDepth: number }): Effect.Effect<TurnEventsService, never, Scope.Scope> => Effect.gen(function* () {
  const subscribers = yield* Ref.make<ReadonlyArray<Subscriber>>([])
  const nextId = yield* Ref.make(0)
  // Each bus counts its own nesting, and knows its own lanes: references keyed by this bus alone.
  const busId = yield* randomUuid
  const depth = Context.Reference<number>(`@xandreed/core/TurnEvents/depth/${busId}`, { defaultValue: () => 0 })
  /** Whether this runs in a background handler of this bus, on its lane's fiber. */
  const inLane = Context.Reference<boolean>(`@xandreed/core/TurnEvents/lane/${busId}`, { defaultValue: () => false })
  /** Background deliveries so far: the drain repeats until a pass queues nothing new. */
  const queued = yield* Ref.make(0)
  const publish = (event: TurnEvent): Effect.Effect<void, HarnessError> => Effect.gen(function* () {
    const current = yield* Effect.service(depth)
    if (current >= options.maxDepth) {
      return yield* Effect.fail(new HarnessError({ code: "events.depth", message: `${event._tag} published ${current} levels deep; a reaction cycle?` }))
    }
    const all = yield* Ref.get(subscribers)
    yield* Effect.forEach(all, (subscriber) => subscriber.deliver(event), { discard: true }).pipe(Effect.provideService(depth, current + 1))
  })

  /**
   * A queue and a fiber: handled in order, off the publisher's path; its
   * depth and trace content switch travel with each event. `room` holds
   * the capacity: a publisher takes a place before it queues an event, and
   * the lane gives it back as it takes the event. A background handler
   * queues without a place (it never waits), markers too.
   */
  const background = <E>(handle: (event: E) => Effect.Effect<void, HarnessError>, capacity: number) => Effect.gen(function* () {
    const queue = yield* Queue.unbounded<Queued<E>>()
    const room = yield* Semaphore.make(capacity)
    const failed = yield* Ref.make(Option.none<Cause.Cause<HarnessError>>())
    const take: Effect.Effect<void> = Queue.take(queue).pipe(Effect.flatMap((item) => Effect.gen(function* () {
      const failure = yield* Ref.get(failed)
      if (item._tag === "Marker") {
        yield* Option.match(failure, { onNone: () => Deferred.succeed(item.done, undefined), onSome: (cause) => Deferred.failCause(item.done, cause) })
        return
      }
      if (item.roomed) yield* room.release(1)
      if (Option.isSome(failure)) return
      yield* handle(item.event).pipe(
        Effect.provideService(depth, item.depth),
        Effect.provideService(CurrentTraceContent, item.traceContent),
        Effect.provideService(inLane, true),
        Effect.catchCause((cause) => Ref.set(failed, Option.some(failureOf(cause)))),
      )
    })))
    yield* Effect.forkScoped(Effect.forever(take))
    const deliver = (event: E): Effect.Effect<void, HarnessError> => Effect.gen(function* () {
      const failure = yield* Ref.get(failed)
      if (Option.isSome(failure)) return yield* Effect.failCause(failure.value)
      yield* Ref.update(queued, (value) => value + 1)
      const item = { _tag: "Event" as const, event, depth: yield* Effect.service(depth), traceContent: yield* Effect.service(CurrentTraceContent) }
      // A background handler of this bus never waits for room: it may be what would make room.
      if (yield* Effect.service(inLane)) return yield* Queue.offer(queue, { ...item, roomed: false }).pipe(Effect.asVoid)
      // The wait for room can be interrupted even where the publisher is not (a failed turn recording its reply);
      // a place taken is always used.
      yield* Effect.uninterruptible(Effect.interruptible(room.take(1)).pipe(Effect.andThen(Queue.offer(queue, { ...item, roomed: true }))))
    })
    const drain = Deferred.make<void, HarnessError>().pipe(Effect.flatMap((done) =>
      Queue.offer(queue, { _tag: "Marker", done }).pipe(Effect.andThen(Deferred.await(done)))))
    return { deliver, drain }
  })

  const subscribe = <E, R>(select: (event: TurnEvent) => Option.Option<E>, handle: (event: E) => Effect.Effect<void, HarnessError, R>, subscribeOptions?: SubscribeOptions) =>
    Effect.gen(function* () {
      // Traced where it runs: an inline handler under the publisher's span, with the publisher's trace content.
      const context = replayableContext(yield* Effect.context<R>())
      const id = yield* Ref.getAndUpdate(nextId, (value) => value + 1)
      const handled = (selected: E) => handle(selected).pipe(Effect.provide(context))
      const mode = subscribeOptions?.mode ?? "inline"
      const lane = mode === "background"
        ? yield* background(handled, subscribeOptions?.capacity ?? defaultCapacity)
        : { deliver: handled, drain: Effect.void }
      const deliver = (event: TurnEvent): Effect.Effect<void, HarnessError> => Option.match(select(event), {
        onNone: () => Effect.void,
        onSome: lane.deliver,
      })
      yield* Ref.update(subscribers, (all) => [...all, { id, deliver, drain: lane.drain }])
      yield* Effect.addFinalizer(() => Ref.update(subscribers, (all) => all.filter((subscriber) => subscriber.id !== id)))
    })

  /** Drain every background subscription; again while draining queued more (reactions of reactions). */
  const drain: Effect.Effect<void, HarnessError> = Effect.gen(function* () {
    const before = yield* Ref.get(queued)
    yield* Effect.forEach(yield* Ref.get(subscribers), (subscriber) => subscriber.drain, { discard: true })
    if ((yield* Ref.get(queued)) !== before) yield* Effect.suspend(() => drain)
  })
  return { publish, subscribe, drain, activity: Ref.get(queued) }
})

interface Task {
  readonly tag: string
  readonly fiber: Fiber.Fiber<void, HarnessError>
}

/** Background work forked in `scope`: interrupted when it closes, joined on demand. `activity` counts tasks forked so far. */
export const makeTurnTasks = (scope: Scope.Scope): Effect.Effect<TurnTasksService> => Effect.gen(function* () {
  const tasks = yield* Ref.make<ReadonlyArray<Task>>([])
  const fork = <R>(tag: string, task: Effect.Effect<void, HarnessError, R>) => Effect.gen(function* () {
    const context = yield* Effect.context<R>()
    const fiber = yield* Effect.forkIn(task.pipe(Effect.provide(context)), scope)
    yield* Ref.update(tasks, (all) => [...all, { tag, fiber }])
  })
  const pending = (tag: string) => Ref.get(tasks).pipe(
    Effect.flatMap((all) => Effect.forEach(all.filter((task) => task.tag === tag), (task) => Effect.sync(() => task.fiber.pollUnsafe()))),
    Effect.map((polls) => polls.some((exit) => exit === undefined)),
  )
  /** Joins from `from` on, then again for tasks the joined ones forked meanwhile. */
  const awaitFrom = (tags: ReadonlyArray<string>, from: number): Effect.Effect<void, HarnessError> => Ref.get(tasks).pipe(
    Effect.flatMap((all) => all.length === from ? Effect.void : Effect.forEach(
      all.slice(from).filter((task) => tags.length === 0 || tags.includes(task.tag)),
      (task) => Fiber.join(task.fiber),
      { discard: true },
    ).pipe(Effect.andThen(Effect.suspend(() => awaitFrom(tags, all.length))))),
  )
  return { fork, pending, await: (tags) => awaitFrom(tags, 0), activity: Ref.get(tasks).pipe(Effect.map((all) => all.length)) }
})

/**
 * Callbacks with a `never` error channel (the loop's, a tool wrapper's
 * publish) carry a HarnessError as a defect; this restores it as a failure
 * at the turn boundary so a subscriber failure fails the turn, typed.
 */
export const harnessDefectsAsFailures = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | HarnessError, R> =>
  effect.pipe(Effect.catchDefect((defect) => isHarnessError(defect) ? Effect.fail(defect) : Effect.die(defect)))
