import { Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"

/**
 * A turn this process holds open: its session, its number, and since when
 * (this process's Clock time, in milliseconds, when its begin was stored and
 * its writer handed over).
 */
export const ActiveTurn = Schema.Struct({
  session: ConversationId,
  turn: Schema.Int,
  since: Schema.Number,
})
export type ActiveTurn = typeof ActiveTurn.Type

/**
 * The turns a `Sessions` holds open and the begins it is still working on
 * (waiting for the host's admission, committing, starting the writer),
 * read at one moment.
 *
 * @public
 */
export const TurnsInFlight = Schema.Struct({
  open: Schema.Array(ActiveTurn),
  beginning: Schema.Int,
})
export type TurnsInFlight = typeof TurnsInFlight.Type

/**
 * What this process is busy with, for a `/ping` or a graceful shutdown: the
 * turns it holds open (oldest first), the begins still in progress, the
 * background tasks it runs, and whether there is any of them.
 */
export const ProcessActivity = Schema.Struct({
  openTurns: Schema.Array(ActiveTurn),
  beginningTurns: Schema.Int,
  runningTasks: Schema.Int,
  busy: Schema.Boolean,
})
export type ProcessActivity = typeof ProcessActivity.Type

/**
 * How a graceful shutdown went (`shutdownGracefully`): whether the process
 * was idle before the deadline, the turns it then interrupted (each ended
 * `turn.shutdown`), and what was still in flight when it returned (`busy`
 * false once every interrupted turn's scope has closed and every task has
 * ended).
 */
export const ShutdownReport = Schema.Struct({
  idle: Schema.Boolean,
  interrupted: Schema.Array(ActiveTurn),
  left: ProcessActivity,
})
export type ShutdownReport = typeof ShutdownReport.Type
