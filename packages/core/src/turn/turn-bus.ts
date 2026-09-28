import { Cause, Deferred, Effect, Fiber, FiberRef, Option, Queue, Ref } from "effect"
import type { Scope } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import type { SubscribeOptions, TurnEventsService, TurnTasksService } from "../ports/turn-events.port.js"
import type { TurnEvent } from "./turn-event.entity.js"

interface Subscriber {
  readonly id: number
  readonly deliver: (event: TurnEvent) => Effect.Effect<void, HarnessError>
  /** Background subscriptions: wait until everything queued so far is handled. */
  readonly drain: Effect.Effect<void, HarnessError>
}

/** One queued delivery, or a marker the drain waits on. */
type Queued<E> =
  | { readonly _tag: "Event"; readonly event: E; readonly depth: number }
  | { readonly _tag: "Marker"; readonly done: Deferred.Deferred<void, HarnessError> }

/** A background handler's failure as the typed error the turn fails with. */
const failureOf = (cause: Cause.Cause<HarnessError>): HarnessError => Option.getOrElse(Cause.failureOption(cause), () => {
  const defect = Cause.squash(cause)
  return defect instanceof HarnessError ? defect : new HarnessError({ code: "events.background", message: Cause.pretty(cause).slice(0, 300) })
})

const defaultCapacity = 256

/**
 * An ordered event bus. `publish` runs every inline subscriber in
 * subscription order before it returns; a handler may publish in turn
 * (depth-first) up to `maxDepth`, which catches reaction cycles. Background
 * subscribers get the event on their own queue and handle it in order on
 * their own fiber; `drain` waits for them. `activity` counts background
 * deliveries so far, so a caller can tell whether a drain left new work.
 */
export const makeTurnEvents = (options: { readonly maxDepth: number }): Effect.Effect<TurnEventsService, never, Scope.Scope> => Effect.gen(function* () {
  const subscribers = yield* Ref.make<ReadonlyArray<Subscriber>>([])
  const nextId = yield* Ref.make(0)
  const depth = yield* FiberRef.make(0)
  /** Background deliveries so far: the drain repeats until a pass queues nothing new. */
  const queued = yield* Ref.make(0)
  const publish = (event: TurnEvent): Effect.Effect<void, HarnessError> => Effect.gen(function* () {
    const current = yield* FiberRef.get(depth)
    if (current >= options.maxDepth) {
      return yield* Effect.fail(new HarnessError({ code: "events.depth", message: `${event._tag} published ${current} levels deep; a reaction cycle?` }))
    }
    const all = yield* Ref.get(subscribers)
    yield* Effect.forEach(all, (subscriber) => subscriber.deliver(event), { discard: true }).pipe(Effect.locally(depth, current + 1))
  })

  /** A queue and a fiber: handled in order, off the publisher's path; its depth travels with each event. */
  const background = <E>(handle: (event: E) => Effect.Effect<void, HarnessError>, capacity: number) => Effect.gen(function* () {
    const queue = yield* Queue.bounded<Queued<E>>(capacity)
    const failed = yield* Ref.make(Option.none<HarnessError>())
    const take: Effect.Effect<void> = Queue.take(queue).pipe(Effect.flatMap((item) => Effect.gen(function* () {
      const failure = yield* Ref.get(failed)
      if (item._tag === "Marker") {
        yield* Option.match(failure, { onNone: () => Deferred.succeed(item.done, undefined), onSome: (error) => Deferred.fail(item.done, error) })
        return
      }
      if (Option.isSome(failure)) return
      yield* handle(item.event).pipe(
        Effect.locally(depth, item.depth),
        Effect.catchAllCause((cause) => Ref.set(failed, Option.some(failureOf(cause)))),
      )
    })))
    yield* Effect.forkScoped(Effect.forever(take))
    const deliver = (event: E): Effect.Effect<void, HarnessError> => Effect.gen(function* () {
      const failure = yield* Ref.get(failed)
      if (Option.isSome(failure)) return yield* Effect.fail(failure.value)
      yield* Ref.update(queued, (value) => value + 1)
      yield* Queue.offer(queue, { _tag: "Event", event, depth: yield* FiberRef.get(depth) })
    })
    const drain = Deferred.make<void, HarnessError>().pipe(Effect.flatMap((done) =>
      Queue.offer(queue, { _tag: "Marker", done }).pipe(Effect.zipRight(Deferred.await(done)))))
    return { deliver, drain }
  })

  const subscribe = <E, R>(select: (event: TurnEvent) => Option.Option<E>, handle: (event: E) => Effect.Effect<void, HarnessError, R>, subscribeOptions?: SubscribeOptions) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>()
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
  readonly fiber: Fiber.RuntimeFiber<void, HarnessError>
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
    Effect.flatMap((all) => Effect.forEach(all.filter((task) => task.tag === tag), (task) => task.fiber.poll)),
    Effect.map((polls) => polls.some(Option.isNone)),
  )
  /** Joins from `from` on, then again for tasks the joined ones forked meanwhile. */
  const awaitFrom = (tags: ReadonlyArray<string>, from: number): Effect.Effect<void, HarnessError> => Ref.get(tasks).pipe(
    Effect.flatMap((all) => all.length === from ? Effect.void : Effect.forEach(
      all.slice(from).filter((task) => tags.length === 0 || tags.includes(task.tag)),
      (task) => Fiber.join(task.fiber),
      { discard: true },
    ).pipe(Effect.zipRight(Effect.suspend(() => awaitFrom(tags, all.length))))),
  )
  return { fork, pending, await: (tags) => awaitFrom(tags, 0), activity: Ref.get(tasks).pipe(Effect.map((all) => all.length)) }
})

/**
 * Callbacks with a `never` error channel (the loop's, a tool wrapper's
 * publish) carry a HarnessError as a defect; this restores it as a failure
 * at the turn boundary so a subscriber failure fails the turn, typed.
 */
export const harnessDefectsAsFailures = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | HarnessError, R> =>
  effect.pipe(Effect.catchSomeDefect((defect) => defect instanceof HarnessError ? Option.some(Effect.fail(defect)) : Option.none()))
