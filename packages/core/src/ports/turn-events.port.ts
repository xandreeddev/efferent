import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { TurnEvent } from "../turn/turn-event.entity.js"

/**
 * How a subscription receives events.
 * - `inline` (default): the handler runs before `publish` returns, so the
 *   state it changes is visible to the next step; its failure fails the publisher.
 * - `background`: events are queued (bounded, in order) for the handler's own
 *   fiber, so the publisher never waits on it. The turn drains every
 *   background subscription before it ends; a handler failure fails the
 *   next delivery to it and the drain.
 */
export interface SubscribeOptions {
  readonly mode?: "inline" | "background"
  /** Background queue size; publishing waits when it is full. */
  readonly capacity?: number
}

/**
 * The turn's event bus. Publication is ordered: subscribers are served in
 * subscription order, depth-first (a handler may publish in turn, up to a
 * depth cap). Inline handlers run before `publish` returns; background ones
 * are queued. Background work that is not a reaction belongs in `TurnTasks`.
 */
export interface TurnEventsService {
  readonly publish: (event: TurnEvent) => Effect.Effect<void, HarnessError>
  /** Active until the caller's scope closes. `select` narrows and decodes. */
  readonly subscribe: <E, R>(
    select: (event: TurnEvent) => Option.Option<E>,
    handle: (event: E) => Effect.Effect<void, HarnessError, R>,
    options?: SubscribeOptions,
  ) => Effect.Effect<void, never, R | Scope.Scope>
  /** Wait until every background subscription has handled what was published to it. */
  readonly drain: Effect.Effect<void, HarnessError>
  /** Background deliveries so far: a caller can tell whether a drain left new work. */
  readonly activity: Effect.Effect<number>
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
  /** Tasks forked so far: a caller can tell whether joining them started more. */
  readonly activity: Effect.Effect<number>
}

export class TurnEvents extends Context.Service<TurnEvents, TurnEventsService>()("efferent/TurnEvents") {}
export class TurnTasks extends Context.Service<TurnTasks, TurnTasksService>()("efferent/TurnTasks") {}

/** One subscription, ready to attach to a turn's bus (see `onTool`, `onEvent`). */
export type Subscription<R> = (events: TurnEventsService) => Effect.Effect<void, never, R | Scope.Scope>
