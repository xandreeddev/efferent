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

/** Pending durable user inputs in an owner-checked session this Sessions instance has observed. */
export const WaitingInputCount = Schema.Struct({
  session: ConversationId,
  pending: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type WaitingInputCount = typeof WaitingInputCount.Type

/**
 * What this process is busy with, for a `/ping` or a graceful shutdown: the
 * turns it holds open (oldest first), the begins still in progress, the
 * background tasks and drain attempts it runs, and queued user input in
 * sessions its Sessions has observed. inFlight describes active work; busy
 * includes durable backlog too. It also reports whether the process is
 * stopping (its `TurnShutdown` refuses new turns: a load balancer stops
 * sending it any).
 */
export const ProcessActivity = Schema.Struct({
  openTurns: Schema.Array(ActiveTurn),
  beginningTurns: Schema.Int,
  runningTasks: Schema.Int,
  /** Known sessions with pending durable user input; zero counts are omitted. */
  waiting: Schema.Array(WaitingInputCount),
  /** The sum of the pending counts in waiting; legacy notices do not count. */
  queuedInput: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** An open/beginning turn, task or active drain attempt, excluding queued backlog and retry timers. */
  inFlight: Schema.Boolean,
  busy: Schema.Boolean,
  stopping: Schema.Boolean,
})
export type ProcessActivity = typeof ProcessActivity.Type

/**
 * How a graceful shutdown went (`shutdownGracefully`): whether the process
 * had no work in flight before the deadline, the turns it then interrupted
 * (each ended `turn.shutdown`), and the final activity. left.busy may remain
 * true because input is retained for the next process even when
 * left.inFlight is false. Queue counts are cached, without storage I/O.
 */
export const ShutdownReport = Schema.Struct({
  idle: Schema.Boolean,
  interrupted: Schema.Array(ActiveTurn),
  left: ProcessActivity,
})
export type ShutdownReport = typeof ShutdownReport.Type
