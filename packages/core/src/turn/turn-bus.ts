import { Effect, Fiber, FiberRef, Option, Ref } from "effect"
import type { Scope } from "effect"
import { HarnessError } from "../harness/plugin.entity.js"
import type { TurnEventsService, TurnTasksService } from "../ports/turn-events.port.js"
import type { TurnEvent } from "./turn-event.entity.js"

interface Subscriber {
  readonly id: number
  readonly deliver: (event: TurnEvent) => Effect.Effect<void, HarnessError>
}

/**
 * An inline, ordered event bus. `publish` runs every subscriber in
 * subscription order before it returns; a handler may publish in turn
 * (depth-first) up to `maxDepth`, which catches reaction cycles.
 */
export const makeTurnEvents = (options: { readonly maxDepth: number }): Effect.Effect<TurnEventsService, never, Scope.Scope> => Effect.gen(function* () {
  const subscribers = yield* Ref.make<ReadonlyArray<Subscriber>>([])
  const nextId = yield* Ref.make(0)
  const depth = yield* FiberRef.make(0)
  const publish = (event: TurnEvent): Effect.Effect<void, HarnessError> => Effect.gen(function* () {
    const current = yield* FiberRef.get(depth)
    if (current >= options.maxDepth) {
      return yield* Effect.fail(new HarnessError({ code: "events.depth", message: `${event._tag} published ${current} levels deep; a reaction cycle?` }))
    }
    const all = yield* Ref.get(subscribers)
    yield* Effect.forEach(all, (subscriber) => subscriber.deliver(event), { discard: true }).pipe(Effect.locally(depth, current + 1))
  })
  const subscribe = <E, R>(select: (event: TurnEvent) => Option.Option<E>, handle: (event: E) => Effect.Effect<void, HarnessError, R>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<R>()
      const id = yield* Ref.getAndUpdate(nextId, (value) => value + 1)
      const deliver = (event: TurnEvent): Effect.Effect<void, HarnessError> => Option.match(select(event), {
        onNone: () => Effect.void,
        onSome: (selected) => handle(selected).pipe(Effect.provide(context)),
      })
      yield* Ref.update(subscribers, (all) => [...all, { id, deliver }])
      yield* Effect.addFinalizer(() => Ref.update(subscribers, (all) => all.filter((subscriber) => subscriber.id !== id)))
    })
  return { publish, subscribe } satisfies TurnEventsService
})

interface Task {
  readonly tag: string
  readonly fiber: Fiber.RuntimeFiber<void, HarnessError>
}

/** Background work forked in `scope`: interrupted when it closes, joined on demand. */
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
  return { fork, pending, await: (tags) => awaitFrom(tags, 0) } satisfies TurnTasksService
})

/**
 * Callbacks with a `never` error channel (the loop's, a tool wrapper's
 * publish) carry a HarnessError as a defect; this restores it as a failure
 * at the turn boundary so a subscriber failure fails the turn, typed.
 */
export const harnessDefectsAsFailures = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | HarnessError, R> =>
  effect.pipe(Effect.catchSomeDefect((defect) => defect instanceof HarnessError ? Option.some(Effect.fail(defect)) : Option.none()))
