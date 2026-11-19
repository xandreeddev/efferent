import { Schema } from "effect"
import { SessionId, TurnNumber } from "@xandreed/core"

/**
 * A turn `recoverTurns` closed: the session it was open in, and its number.
 * Its end, `core.session.turn.ended` with the outcome `Abandoned`, is in that
 * session's journal.
 *
 * @public
 */
export const RecoveredTurn = Schema.Struct({ session: SessionId, turn: TurnNumber })
export type RecoveredTurn = typeof RecoveredTurn.Type

/**
 * A session `recoverTurns` could not read (the store said `Unreadable`: a
 * damaged line, a record out of its place): it was passed over, nothing was
 * written to it, and a turn it holds open stays open. `message` is the
 * store's, which names the session and what is wrong. A host repairs or
 * removes the session; trying again does not help.
 *
 * @public
 */
export const UnreadableSession = Schema.Struct({ session: SessionId, message: Schema.String })
export type UnreadableSession = typeof UnreadableSession.Type

/**
 * What `recoverTurns` did: the turns it closed, and the sessions it passed
 * over because the store could not read them, each in the order of
 * `Sessions.list`.
 *
 * @public
 */
export const Recovery = Schema.Struct({ closed: Schema.Array(RecoveredTurn), unreadable: Schema.Array(UnreadableSession) })
export type Recovery = typeof Recovery.Type
