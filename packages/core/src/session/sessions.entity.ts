import { Schema } from "effect"
import { AttachmentRejected } from "../domain/media.entity.js"
import { ConversationId } from "../domain/message.entity.js"
import { RunId } from "../domain/run.entity.js"
import { TurnOrigin } from "../domain/turn-vocabulary.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import { UserMessage } from "../turn/user-message.entity.js"
import { JsonObject, SessionHeader, SessionListCursor, SessionLogError, SessionMissing } from "./session-log.entity.js"
import { TaskRef } from "./tasks.entity.js"

/*
 * What hosts and turns see of sessions (the `Sessions` service): addresses,
 * the open turn, the inbox and the view of one session. How a session's
 * state is kept is the sessions plugin's.
 */

/** A session as its owner names it; another owner's address finds nothing. */
export const SessionAddress = Schema.Struct({ id: ConversationId, owner: Schema.Trimmed.check(Schema.isNonEmpty()) })
export type SessionAddress = typeof SessionAddress.Type

/**
 * An inbox item's id, as its sender gives it: trimmed and non-empty. Stable:
 * delivering the same id twice stores it once. A stored one
 * (`inbox.queued`, `inbox.dropped`) carries the same brand and is read back
 * as stored.
 */
export const InboxItemId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("InboxItemId"))
export type InboxItemId = typeof InboxItemId.Type

/** Something delivered to a session for a later turn (a background task's result). */
export const InboxItem = Schema.Struct({
  /** Stable: delivering the same id twice stores it once. */
  id: InboxItemId,
  /** Who sent it and why, for the host and the UI. */
  source: JsonObject,
  /** What the turn that takes it shows the model, framed by the sender. */
  content: Schema.NonEmptyString,
})
export type InboxItem = typeof InboxItem.Type

/** The turn a session has open. */
export const OpenTurn = Schema.Struct({
  turn: Schema.Int,
  runId: RunId,
  key: Schema.String,
  origin: TurnOrigin,
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

/**
 * A page of an owner's sessions and where the next page starts.
 *
 * @public
 */
export const SessionPage = Schema.Struct({
  sessions: Schema.Array(SessionView),
  next: Schema.OptionFromNullOr(SessionListCursor),
})
export type SessionPage = typeof SessionPage.Type

/**
 * The host's metadata for one turn (a request id, a client, a tenant…): stored
 * in the turn's `turn.started` and shown to the host on `AdmittedTurn`,
 * `TurnToAdmit`, `RunContext.admitted` and the bus `turn.started`. Never shown
 * to the model, and never part of the idempotency key's fingerprint: a retry
 * with other metadata is still the same turn.
 */
const TurnMeta = Schema.optionalKey(JsonObject)

/**
 * The earlier turn a user's turn resumes: the number of the session's last
 * turn begun by a user, which ended cancelled or interrupted (only inbox
 * turns, and resumes of it that failed, were cancelled or were interrupted,
 * may have run since). Memory is unchanged by it: the model sees what a
 * plain new turn would, the earlier turn's message and whole steps, then the
 * new turn's own message. Stored in the new turn's `turn.started` and shown
 * on `AdmittedTurn`, `TurnToAdmit` and the bus `turn.started`, only when
 * given; part of the key's fingerprint.
 */
const Resumes = Schema.optionalKey(Schema.Int)

/**
 * The task a task's turn runs, stored in its `turn.started` and shown on
 * `AdmittedTurn` and `TurnToAdmit` (origin `task` only); part of the key's
 * fingerprint.
 */
const TaskOf = Schema.optionalKey(TaskRef)

/**
 * Take the session over: the host says the process that holds its open
 * turn is gone (a restarted worker, a moved session), so the begin closes a
 * turn still held at once, whatever its lease or holder, as `interrupted`
 * with code `turn.takeover` (resumable; its inbox items wait again, no
 * attempt counted), in the commit that opens the new turn; a turn no longer
 * held is reaped as any begin reaps it (`turn.lease`). A holder still
 * running is fenced at its next write (`TurnClosed`), but what it did
 * before is not undone. Without it, a turn still held makes the begin
 * `SessionBusy`. Input only: never stored, and not part of the key's
 * fingerprint.
 */
const TakeOver = Schema.optionalKey(Schema.Boolean)

/**
 * How a turn begins: a user's message, the inbox's pending items, or a
 * background task's instructions (the one turn of its child session, begun
 * by the tasks plugin; origin `task`, which cannot be resumed).
 */
export const BeginTurn = Schema.Union([
  Schema.TaggedStruct("User", {
    userMessage: UserMessage,
    runId: RunId,
    /** The host's idempotency key (e.g. the client's command id). */
    key: Schema.String,
    command: JsonObject,
    meta: TurnMeta,
    /** The turn this one resumes (see `NotResumable` for which turns can be). */
    resumes: Resumes,
    takeOver: TakeOver,
  }),
  Schema.TaggedStruct("Inbox", { runId: RunId, meta: TurnMeta, takeOver: TakeOver }),
  Schema.TaggedStruct("Task", {
    task: TaskRef,
    /** The task's instructions, as the model is given them. */
    userMessage: UserMessage,
    runId: RunId,
    /** The idempotency key: the task's, so the task's turn begins once. */
    key: Schema.String,
    meta: TurnMeta,
    takeOver: TakeOver,
  }),
])
export type BeginTurn = typeof BeginTurn.Type

/** An admitted turn, as the turn's code reads it. */
export const AdmittedTurn = Schema.Struct({
  session: SessionAddress,
  turn: Schema.Int,
  runId: RunId,
  key: Schema.String,
  origin: TurnOrigin,
  userMessage: UserMessage,
  command: JsonObject,
  claimed: Schema.Array(InboxItem),
  /** The host's metadata the turn was begun with (`{}` when none was given). */
  meta: JsonObject,
  /** The turn this one resumes, when it resumes one. */
  resumes: Resumes,
  /** The task a task's turn runs (origin `task`). */
  task: TaskOf,
})
export type AdmittedTurn = typeof AdmittedTurn.Type

/** A session already has a turn open: one message at a time (a host answers 409). */
export class SessionBusy extends Schema.TaggedError<SessionBusy>()("SessionBusy", {
  session: ConversationId,
  turn: Schema.Int,
}) {}

/** The key was begun before with the same message, command, `resumes` and task: that turn is the answer. */
export class TurnDuplicate extends Schema.TaggedError<TurnDuplicate>()("TurnDuplicate", {
  session: ConversationId,
  turn: Schema.Int,
  open: Schema.Boolean,
}) {}

/** The key was begun before with another message, command, `resumes` or task. */
export class KeyConflict extends Schema.TaggedError<KeyConflict>()("KeyConflict", {
  session: ConversationId,
  key: Schema.String,
  turn: Schema.Int,
}) {}

/**
 * A user's turn asked to resume a turn that cannot be resumed: `missing`, no
 * such turn in the session's own log (a fork's inherited turns are its
 * parent's; a `resumes` that is not a whole number of at least 1 names no
 * turn); `inbox`, an inbox turn; `task`, a background task's turn;
 * `superseded`, a user's turn was begun after
 * it (other than a resume of it that failed, was cancelled or was
 * interrupted); `finished`, it ended completed, partial or failed. Only the
 * last user's turn, ended cancelled or interrupted (a turn reaped because
 * its holder stopped is interrupted), can be resumed. Nothing was opened.
 * `turn` is the `resumes` asked for, as given.
 */
export class NotResumable extends Schema.TaggedError<NotResumable>()("NotResumable", {
  session: ConversationId,
  turn: Schema.Number,
  reason: Schema.Literals(["missing", "superseded", "finished", "inbox", "task"]),
}) {}

/**
 * The run id was used before, by `turn` of the session or of the history a
 * fork inherits: a run id names one turn's run (memory numbers the turn's
 * entries `<runId>:<n>` from it), so every begin needs a new one, a retry
 * under a new key included. Nothing was opened.
 */
export class RunIdReused extends Schema.TaggedError<RunIdReused>()("RunIdReused", {
  session: ConversationId,
  runId: RunId,
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

/**
 * The turn's writer takes no more writes: someone else closed the turn
 * (`cancelled`; `interrupted`, its lease reaped or its holder gone;
 * `removed`, its session removed), or it was `ended` by its own writer (its
 * end stored or under way, or its scope closed). `TurnWriter.closed` gives
 * only the first three.
 */
export class TurnClosed extends Schema.TaggedError<TurnClosed>()("TurnClosed", {
  session: ConversationId,
  turn: Schema.Int,
  reason: Schema.Literals(["cancelled", "interrupted", "removed", "ended"]),
}) {}

/**
 * The host would not open the turn (a budget, a quota), or the process is
 * shutting down (reason `shutdown`, `isShutdownRefusal`): nothing was
 * opened or counted.
 */
export class TurnRefused extends Schema.TaggedError<TurnRefused>()("TurnRefused", {
  session: ConversationId,
  reason: Schema.String,
  message: Schema.String,
}) {}

/** The `reason` of the `TurnRefused` a Sessions answers every begin with once it is shutting down (`TurnShutdown`). */
export const SHUTDOWN_REFUSAL = "shutdown"

/**
 * Writes to the session kept conflicting: `attempts` commits in a row lost
 * to other writers, and nothing was written. Retry later (a host answers
 * 503).
 */
export class SessionContended extends Schema.TaggedError<SessionContended>()("SessionContended", {
  session: ConversationId,
  attempts: Schema.Int,
}) {}

/**
 * Why a turn could not begin: a refusal of `Sessions.begin`, or
 * `AttachmentRejected` from the check of the message's images before it.
 * Nothing was opened. `Agent.turn` (any `TurnRunner`) fails with it as it
 * is, so a host matches one with `Effect.catchTag("SessionBusy", …)`.
 */
export const TurnBeginError = Schema.Union([
  AttachmentRejected, SessionBusy, TurnDuplicate, KeyConflict, RunIdReused, NothingPending, NotResumable, TurnRefused, SessionMissing,
  SessionContended, SessionLogError,
])
export type TurnBeginError = typeof TurnBeginError.Type

/**
 * The code each begin refusal stands for, keyed by its tag: what
 * `harnessCodeOf` (and `turnEndingOf`) gives for the refusal `Agent.turn`
 * fails with when the turn cannot begin, and what a turn that fails with
 * it stores.
 */
export const turnBeginCodes = {
  AttachmentRejected: "turn.attachment-rejected",
  SessionBusy: "session.busy",
  TurnDuplicate: "turn.duplicate",
  KeyConflict: "turn.key-conflict",
  RunIdReused: "turn.run-reused",
  NothingPending: "session.nothing-pending",
  NotResumable: "turn.not-resumable",
  TurnRefused: "turn.refused",
  SessionMissing: "session.missing",
  SessionContended: "session.contended",
  SessionLogError: "session.log",
} as const satisfies Record<TurnBeginError["_tag"], string>

/**
 * What a turn's own writes fail with, and the ports on the turn's path that
 * write through them (`TurnWriter`, `RunContext`, the bus, memory, the step
 * loop, the tool registry, `Turn`, `TurnRunner`): `TurnClosed` once the
 * turn takes no more writes, `ReservedKind` for a draft under one of the
 * framework's kinds, `SessionContended` and `SessionLogError` from the
 * store, and a `HarnessError` for the rest. Match the first four with
 * `Effect.catchTag`; `harnessCodeOf` gives the code each stands for
 * (`turn.closed`, `events.reserved`, `session.contended`, `session.log`),
 * the code a turn failing with it stores. One carried as a defect behind a
 * `never` error channel is restored by `harnessDefectsAsFailures`
 * (`isTurnError` tells one, from any copy of core).
 */
export type TurnError = HarnessError | TurnClosed | ReservedKind | SessionContended | SessionLogError
