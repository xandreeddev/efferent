import { Schema } from "effect"
import { Owner, SessionId, TurnNumber } from "./ids.entity.js"

/**
 * The format of a kernel journal: its header and its envelopes.
 *
 * @public
 */
export const JOURNAL_FORMAT = 1

/** What a session is created with: who it belongs to, and the session it continues, if any. */
export const NewSession = Schema.Struct({ owner: Owner, parent: Schema.optionalKey(SessionId) })
export type NewSession = typeof NewSession.Type

/**
 * A session's header, stored once and never changed.
 *
 * @public
 */
export const SessionHeader = Schema.Struct({
  id: SessionId,
  owner: Owner,
  parent: Schema.optionalKey(SessionId),
  format: Schema.Literal(JOURNAL_FORMAT),
})
export type SessionHeader = typeof SessionHeader.Type

/**
 * A session with no turn open, after `turns` of them.
 *
 * @public
 */
export const Free = Schema.TaggedStruct("Free", { turns: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) })
export type Free = typeof Free.Type

/**
 * A session whose turn `turn` is running.
 *
 * @public
 */
export const TurnOpen = Schema.TaggedStruct("TurnOpen", { turn: TurnNumber })
export type TurnOpen = typeof TurnOpen.Type

/** A session's state: one phase, moved by `beginTurn` and `endTurn`, and the fold of its journal. */
export const SessionState = Schema.Union([Free, TurnOpen])
export type SessionState = typeof SessionState.Type

/** A transition the session's state does not allow: a turn begun while one is open, or ended while none is. */
export class SessionRefused extends Schema.TaggedError<SessionRefused>()("SessionRefused", {
  reason: Schema.Literals(["SessionBusy", "NoOpenTurn"]),
  message: Schema.String,
}) {}

/** What a turn is run with: the session and the user's message. */
export const TurnInput = Schema.Struct({ session: SessionId, message: Schema.String })
export type TurnInput = typeof TurnInput.Type
