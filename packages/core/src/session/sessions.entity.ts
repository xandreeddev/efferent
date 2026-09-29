import { Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { TurnEndReason } from "./session-event.entity.js"
import { JsonObject, SessionHeader, SessionListCursor } from "./session-log.entity.js"

/*
 * What hosts and turns see of sessions (the `Sessions` service): addresses,
 * the open turn, the inbox and the view of one session. How a session's
 * state is kept is the sessions plugin's.
 */

/** A session as its owner names it; another owner's address finds nothing. */
export const SessionAddress = Schema.Struct({ id: ConversationId, owner: Schema.Trimmed.check(Schema.isNonEmpty()) })
export type SessionAddress = typeof SessionAddress.Type

/** Something delivered to a session for a later turn (a background task's result). */
export const InboxItem = Schema.Struct({
  /** Stable: delivering the same id twice stores it once. */
  id: Schema.Trimmed.check(Schema.isNonEmpty()),
  /** Who sent it and why, for the host and the UI. */
  source: JsonObject,
  /** What the turn that takes it shows the model, framed by the sender. */
  content: Schema.NonEmptyString,
})
export type InboxItem = typeof InboxItem.Type

/** The turn a session has open. */
export const OpenTurn = Schema.Struct({
  turn: Schema.Int,
  runId: Schema.String,
  key: Schema.String,
  origin: Schema.Literals(["user", "inbox"]),
  /** The writer holding it (one Sessions instance). */
  holder: Schema.String,
  /** Storage time the lease ends; none under process ownership. */
  expiresAt: Schema.OptionFromNullOr(Schema.Number),
})
export type OpenTurn = typeof OpenTurn.Type

/** One session as a host lists or shows it. `open` is none once its lease has run out. */
export const SessionView = Schema.Struct({
  header: SessionHeader,
  seq: Schema.Int,
  updatedAt: Schema.Number,
  turns: Schema.Int,
  title: Schema.OptionFromNullOr(Schema.String),
  open: Schema.OptionFromNullOr(OpenTurn),
  /** Inbox items waiting for a turn. */
  pending: Schema.Int,
})
export type SessionView = typeof SessionView.Type

/** A page of an owner's sessions and where the next page starts. */
export const SessionPage = Schema.Struct({
  sessions: Schema.Array(SessionView),
  next: Schema.OptionFromNullOr(SessionListCursor),
})
export type SessionPage = typeof SessionPage.Type

/** How a turn begins: a user's message, or the inbox's pending items. */
export const BeginTurn = Schema.Union([
  Schema.TaggedStruct("User", {
    userMessage: UserMessage,
    runId: Schema.String,
    /** The host's idempotency key (e.g. the client's command id). */
    key: Schema.String,
    command: JsonObject,
  }),
  Schema.TaggedStruct("Inbox", { runId: Schema.String }),
])
export type BeginTurn = typeof BeginTurn.Type

/** An admitted turn, as the turn's code reads it. */
export const AdmittedTurn = Schema.Struct({
  session: SessionAddress,
  turn: Schema.Int,
  runId: Schema.String,
  key: Schema.String,
  origin: Schema.Literals(["user", "inbox"]),
  userMessage: UserMessage,
  command: JsonObject,
  claimed: Schema.Array(InboxItem),
})
export type AdmittedTurn = typeof AdmittedTurn.Type

/** How a turn ended, as its closer records it. */
export const TurnEnding = Schema.Struct({
  reason: TurnEndReason,
  failure: Schema.OptionFromNullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
})
export type TurnEnding = typeof TurnEnding.Type

/** A session already has a turn open: one message at a time (a host answers 409). */
export class SessionBusy extends Schema.TaggedError<SessionBusy>()("SessionBusy", {
  session: ConversationId,
  turn: Schema.Int,
}) {}

/** The key was begun before, with the same message: that turn is the answer. */
export class TurnDuplicate extends Schema.TaggedError<TurnDuplicate>()("TurnDuplicate", {
  session: ConversationId,
  turn: Schema.Int,
  open: Schema.Boolean,
}) {}

/** The key was begun before with another message or command. */
export class KeyConflict extends Schema.TaggedError<KeyConflict>()("KeyConflict", {
  session: ConversationId,
  key: Schema.String,
  turn: Schema.Int,
}) {}

/** An inbox turn found nothing to take. */
export class NothingPending extends Schema.TaggedError<NothingPending>()("NothingPending", {
  session: ConversationId,
}) {}

/** The inbox holds as many waiting items as it may. */
export class InboxFull extends Schema.TaggedError<InboxFull>()("InboxFull", {
  session: ConversationId,
  pending: Schema.Int,
}) {}

/** A host tried to record under a kind only the framework writes. */
export class ReservedKind extends Schema.TaggedError<ReservedKind>()("ReservedKind", {
  kind: Schema.String,
}) {}

/** The turn was closed by someone else: cancelled, its lease reaped, or its session removed. */
export class TurnClosed extends Schema.TaggedError<TurnClosed>()("TurnClosed", {
  session: ConversationId,
  turn: Schema.Int,
  reason: Schema.Literals(["cancelled", "interrupted", "removed"]),
}) {}
