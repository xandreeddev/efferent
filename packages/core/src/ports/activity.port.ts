import { Context } from "effect"
import type { Effect } from "effect"
import type { ActiveTurn, TurnsInFlight } from "../session/activity.entity.js"

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

/**
 * How the Sessions that opens this process's turns stops for a shutdown
 * (`SessionsLive` provides it). `refuse`: from now, every begin on it fails
 * with `TurnRefused` of reason `shutdown` (`isShutdownRefusal`), a user's,
 * an inbox's or a task's, while the turns already open run on and
 * deliveries are still stored. `interrupt`: refuse, then close every turn
 * it holds as interrupted with code `turn.shutdown`, storing each end while
 * the log is open (resumable; its inbox items wait again with no attempt
 * counted), and close its writer, so the turn's body is interrupted
 * (`Agent.turn` races `TurnWriter.closed`) and its writes fail with
 * `TurnClosed`; it returns the turns it closed. A turn whose begin was past
 * its opening commit is closed so as soon as its writer is handed over. Both
 * may be called more than once. `shutdownGracefully` calls them; `stopping`
 * says whether either was (what `processActivity` reports).
 */
export class TurnShutdown extends Context.Service<TurnShutdown, {
  readonly refuse: Effect.Effect<void>
  readonly interrupt: Effect.Effect<ReadonlyArray<ActiveTurn>>
  readonly stopping: Effect.Effect<boolean>
}>()("@xandreed/core/TurnShutdown") {}
