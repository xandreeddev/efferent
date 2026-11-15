import { Schema } from "effect"
import { StoredEvent } from "./event.entity.js"
import { Owner, Seq, SessionId, TurnNumber } from "./ids.entity.js"

/**
 * The format of a kernel journal: its header and its envelopes. Format 2
 * added the header's `createdAt` and the `Abandoned` outcome of a turn.
 *
 * @public
 */
export const JOURNAL_FORMAT = 2

/** What a session is created with: who it belongs to, and the session it continues, if any. */
export const NewSession = Schema.Struct({ owner: Owner, parent: Schema.optionalKey(SessionId) })
export type NewSession = typeof NewSession.Type

/**
 * A new session as a host writes it, before it is decoded: an owner and,
 * for a session that continues another, the parent's id, as plain strings.
 *
 * @public
 */
export type NewSessionInput = typeof NewSession.Encoded

/**
 * A session was asked for with an owner that is empty, or a parent that is no session id.
 *
 * @public
 */
export class InvalidSession extends Schema.TaggedError<InvalidSession>()("InvalidSession", {
  message: Schema.String,
}) {}

/**
 * Where a branch was cut (ADR 0016): the session it was copied from, and the place of the last record copied, the
 * end of a closed turn. The branch's journal starts as those records, as they were stored.
 *
 * @public
 */
export const Branch = Schema.Struct({ of: SessionId, through: Seq })
export type Branch = typeof Branch.Type

/**
 * A session's header, stored once and never changed. `parent` is the session a sub-agent works for (ADR 0006);
 * `branch` is where a branch was cut from another session (ADR 0016). A reader that does not know `branch` reads a
 * branch as a session of its own, which it is.
 *
 * @public
 */
export const SessionHeader = Schema.Struct({
  id: SessionId,
  owner: Owner,
  parent: Schema.optionalKey(SessionId),
  branch: Schema.optionalKey(Branch),
  /** When the session was created, in milliseconds since the epoch: what `list` orders by. */
  createdAt: Schema.Number,
  /** The format the journal was written in. A header of any format reads back; a turn opens only on `JOURNAL_FORMAT` (`currentFormat`). */
  format: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
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

/**
 * A session's state: one phase, moved by `beginTurn` and `endTurn`, and the fold of its journal.
 *
 * @public
 */
export const SessionState = Schema.Union([Free, TurnOpen])
export type SessionState = typeof SessionState.Type

/**
 * What a session refuses: a turn begun while one is open (`SessionBusy`), a
 * write to a turn that is not open, or that another writer closed
 * (`NoOpenTurn`), a record a body
 * appends under core's own names, which only the session plugin writes
 * (`ReservedName`), a value to append that `stored` did not make
 * (`NotADraft`), a turn on a journal written in another format than this
 * kernel's (`FormatMismatch`), or a branch cut at a turn that is not closed, or of a session with no closed turn
 * (`NoClosedTurn`).
 */
export class SessionRefused extends Schema.TaggedError<SessionRefused>()("SessionRefused", {
  reason: Schema.Literals(["SessionBusy", "NoOpenTurn", "ReservedName", "NotADraft", "FormatMismatch", "NoClosedTurn"]),
  message: Schema.String,
}) {}

/**
 * A session as a host inspects it (`inspectionOf`): its header, the state its journal folds to, and its journal.
 *
 * @public
 */
export const Inspection = Schema.Struct({
  header: SessionHeader,
  state: SessionState,
  events: Schema.Array(StoredEvent),
})
export type Inspection = typeof Inspection.Type
