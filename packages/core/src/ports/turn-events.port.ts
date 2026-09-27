import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { TurnEvent } from "../turn/turn-event.entity.js"

/**
 * The turn's event bus. Publication is INLINE and ordered: every
 * subscriber runs in subscription order, depth-first (a handler may publish
 * in turn, up to a depth cap), before `publish` returns — so state a
 * subscriber changes is visible to the next step. A handler failure fails
 * the publisher; background work belongs in `TurnTasks`.
 */
export interface TurnEventsService {
  readonly publish: (event: TurnEvent) => Effect.Effect<void, HarnessError>
  /** Active until the caller's scope closes. `select` narrows and decodes. */
  readonly subscribe: <E, R>(
    select: (event: TurnEvent) => Option.Option<E>,
    handle: (event: E) => Effect.Effect<void, HarnessError, R>,
  ) => Effect.Effect<void, never, R | Scope.Scope>
}

/**
 * Background work of one turn. Tasks run in the turn's scope: the turn
 * awaits them before it ends and interrupts them when it fails.
 */
export interface TurnTasksService {
  readonly fork: <R>(tag: string, task: Effect.Effect<void, HarnessError, R>) => Effect.Effect<void, never, R>
  /** True while any task with this tag is still running. */
  readonly pending: (tag: string) => Effect.Effect<boolean>
  /** Join every task with one of these tags (all tasks when empty). */
  readonly await: (tags: ReadonlyArray<string>) => Effect.Effect<void, HarnessError>
}

export class TurnEvents extends Context.Tag("efferent/TurnEvents")<TurnEvents, TurnEventsService>() {}
export class TurnTasks extends Context.Tag("efferent/TurnTasks")<TurnTasks, TurnTasksService>() {}

/** One subscription, ready to attach to a turn's bus (see `onTool`, `onEvent`). */
export type Subscription<R> = (events: TurnEventsService) => Effect.Effect<void, never, R | Scope.Scope>
