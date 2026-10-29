import { Context } from "effect"
import type { Effect } from "effect"
import type { TurnsInFlight } from "../session/activity.entity.js"

/**
 * The turns this process has in flight, from the Sessions service that opens
 * them (`SessionsLive` provides it). A begin counts from the moment it is
 * asked for, through the host's admission and the opening commit, until its
 * writer is handed over (or it fails); the turn then counts as open until
 * its writer's scope closes. Only this process's turns count: one held by
 * another process over the same log does not. `processActivity` and
 * `awaitIdle` read it, when it is there.
 */
export class TurnActivity extends Context.Service<TurnActivity, {
  /** The turns held open now (oldest first) and the begins in progress, read at one moment. */
  readonly current: Effect.Effect<TurnsInFlight>
  /** Completes once no turn is held open and none is beginning (at once when so). */
  readonly idle: Effect.Effect<void>
}>()("efferent/TurnActivity") {}

/**
 * The background work this process runs, from the TaskRunner that runs it
 * (`InProcessTaskRunnerLive` provides it). A piece of work counts from the
 * moment `run` hands it over until it ends. `processActivity` and
 * `awaitIdle` read it, when it is there.
 */
export class TaskActivity extends Context.Service<TaskActivity, {
  /** The pieces of work running now. */
  readonly running: Effect.Effect<number>
  /** Completes once none runs (at once when none does). */
  readonly idle: Effect.Effect<void>
}>()("efferent/TaskActivity") {}
