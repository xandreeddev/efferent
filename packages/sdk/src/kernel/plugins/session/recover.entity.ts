import { Schema } from "effect"
import { SessionId, TurnNumber } from "@xandreed/core/kernel"

/**
 * A turn `recoverTurns` closed: the session it was open in, and its number.
 * Its end, `core.session.turn.ended` with the outcome `Abandoned`, is in that
 * session's journal.
 *
 * @public
 */
export const RecoveredTurn = Schema.Struct({ session: SessionId, turn: TurnNumber })
export type RecoveredTurn = typeof RecoveredTurn.Type
