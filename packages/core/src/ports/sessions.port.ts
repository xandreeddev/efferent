import { Context } from "effect"
import type { Effect, Option, Scope, Stream } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { TurnEnding } from "../domain/turn-vocabulary.entity.js"
import type { JsonObject, SessionExists, SessionListCursor, SessionLogError, SessionLogEvent, SessionMissing } from "../session/session-log.entity.js"
import type {
  AdmittedTurn,
  BeginTurn,
  InboxFull,
  InboxItem,
  ReservedKind,
  SessionAddress,
  SessionContended,
  SessionPage,
  SessionView,
  TurnBeginError,
  TurnClosed,
  TurnError,
} from "../session/sessions.entity.js"

/** One event to record; the writer stamps the turn (or none, outside a turn). */
export interface TurnDraft {
  readonly kind: string
  readonly data: JsonObject
}

/** What a check-then-append decides: the events to record and the caller's result. */
export interface Decision<A> {
  readonly drafts: ReadonlyArray<TurnDraft>
  readonly result: A
}

/** A decision's result and the events it recorded, as stored. */
export interface Decided<A> {
  readonly result: A
  readonly events: ReadonlyArray<SessionLogEvent>
}

/**
 * The open turn's only way to write. Writes are queued and stored in queue
 * order by one writer, consecutive appends in one commit, each commit
 * guarded by the session's revision and the turn's lease: a write the
 * session no longer accepts (cancelled, reaped, removed) closes the writer,
 * and every later write fails with `TurnClosed` (its `reason`; `ended` once
 * the writer's own end is stored or under way, or its scope closed). An
 * append the store fails (`SessionLogError`, or `SessionContended` after
 * too many conflicts in a row), or whose commit dies with a defect
 * (`HarnessError` `session.defect`, logged with its cause), fails every
 * later write and flush with that error. `append` and `transact` refuse a
 * draft under one of the framework's kinds (`RESERVED_KINDS`) with
 * `ReservedKind`, storing nothing of that call, unless the framework's turn
 * wrote it (`frameworkDraft`): only the turn records memory, the bus's
 * events and `request.prepared`. Every method fails with a `TurnError`:
 * match its tags with `Effect.catchTag("TurnClosed", …)`, read its code
 * with `harnessCodeOf`. An implementation raises the tags, never a
 * `HarnessError` of their codes (`sessionsConformance` checks it).
 */
export interface TurnWriter {
  readonly admitted: AdmittedTurn
  /** The `turn.started` event that opened the turn. */
  readonly started: SessionLogEvent
  /** The session's events before this turn (a fork's parent first), of the given kinds: what memory is rebuilt from. */
  readonly history: (kinds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<SessionLogEvent>, TurnError>
  /**
   * A fresh durable snapshot including this turn (a fork's inherited history first). Flush queued writes before reading.
   * With `after`, only this session's own events stored after that seq: the inherited history precedes them all.
   */
  readonly snapshot: (kinds: ReadonlyArray<string>, after?: number) => Effect.Effect<ReadonlyArray<SessionLogEvent>, TurnError>
  /** Queue events; returns once queued. */
  readonly append: (drafts: ReadonlyArray<TurnDraft>) => Effect.Effect<void, TurnError>
  /**
   * Run `op` in queue order (after everything queued before it). When
   * someone else closes the turn meanwhile, `op` is interrupted and the
   * write fails with that `TurnClosed`.
   */
  readonly write: <A, E>(op: Effect.Effect<A, E>) => Effect.Effect<A, E | TurnError>
  /**
   * Check, then append, atomically: `decide` sees the events others wrote
   * during this turn and says what to record. When someone else writes
   * before the commit, it decides again with their events.
   */
  readonly transact: <A, E>(decide: (foreign: ReadonlyArray<SessionLogEvent>) => Effect.Effect<Decision<A>, E>) => Effect.Effect<Decided<A>, E | TurnError>
  /** Wait until everything queued so far is stored. */
  readonly flush: Effect.Effect<void, TurnError>
  /**
   * Close the turn: `turn.ended` is committed after every write queued
   * before it. It is admitted like a write (so it waits while one waits for
   * room in a full queue); from then on `append`, `write` and `transact` are
   * refused, and `flush` still waits for what is queued. Calls while it runs
   * share its result. A stored end, or a turn closed elsewhere, is final;
   * after any other failure (a store error) writes are admitted again and a
   * later end, the scope's own at the latest, tries again: the scope's with
   * the last ending whose commit was tried. Returns how many inbox items
   * wait.
   */
  readonly end: (ending: TurnEnding) => Effect.Effect<{ readonly pending: number }, TurnError>
  /** Completes when someone else closed the turn (never with `ended`); never when it ends by `end`. */
  readonly closed: Effect.Effect<TurnClosed>
}

/**
 * CONSUMPTION: sessions as hosts and turns use them, over the SessionLog a
 * host provides. One turn is open per session at a time — a second begin is
 * `SessionBusy` — and a turn's writes are refused once it is closed, on any
 * instance. The inbox holds deliveries (a background task's result) for the
 * turns that follow: whoever closes a turn, and whoever delivers, drains it.
 * A delivery commits before a turn's closing commit, whose `pending` counts
 * it, or after it, and finds the session free. `Agent.turn` hands the count
 * of a turn it ends to its caller (`TurnResult.pending`), the closer that
 * drains; `drain` ends its own turns and drains what they leave.
 * Reads never write: loading or following a session runs nothing.
 */
export class Sessions extends Context.Service<Sessions, {
  readonly create: (input: {
    readonly owner: string
    readonly id?: ConversationId
    readonly origin?: string
    readonly meta?: JsonObject
  }) => Effect.Effect<SessionView, SessionExists | SessionLogError>
  /**
   * A child session: with `inherit`, its history starts from the parent's
   * last closed turn (a fork); without, it starts empty (a spawn).
   */
  readonly fork: (parent: SessionAddress, input: {
    readonly id?: ConversationId
    readonly origin: string
    readonly meta?: JsonObject
    readonly inherit: boolean
  }) => Effect.Effect<SessionView, SessionExists | SessionMissing | SessionLogError>
  readonly get: (address: SessionAddress) => Effect.Effect<SessionView, SessionMissing | SessionLogError>
  readonly list: (query: {
    readonly owner: string
    readonly limit?: number
    readonly before?: SessionListCursor
    readonly parent?: ConversationId
  }) => Effect.Effect<SessionPage, SessionLogError>
  /** Remove a session and its children; an open turn on this instance is closed. */
  readonly remove: (address: SessionAddress) => Effect.Effect<void, SessionMissing | SessionLogError>
  readonly read: (address: SessionAddress, query?: {
    readonly after?: number
    readonly kinds?: ReadonlyArray<string>
    readonly limit?: number
  }) => Effect.Effect<ReadonlyArray<SessionLogEvent>, SessionMissing | SessionLogError>
  /** A signal after each commit this instance makes to the session (followers poll for the others). */
  readonly changes: (address: SessionAddress) => Stream.Stream<void>
  /** The turn begun with this key, if any. */
  readonly lookup: (address: SessionAddress, key: string) => Effect.Effect<Option.Option<number>, SessionMissing | SessionLogError>
  /** Check, then append outside a turn (a user's action on a page, a setting): decided again on a conflict. */
  readonly transact: <A, E>(address: SessionAddress, decide: (view: SessionView) => Effect.Effect<Decision<A>, E>) =>
    Effect.Effect<Decided<A>, E | ReservedKind | SessionMissing | SessionContended | SessionLogError>
  /**
   * End exactly `turn` as cancelled, if it is the open one and still held:
   * its inbox items are done. A turn nobody holds any more (its lease ran
   * out, its process stopped) is not open (`get` shows none): the cancel
   * reaps it, as a begin or a delivery would, as interrupted (`turn.lease`),
   * its items waiting again (or dropped after too many attempts), and
   * answers `cancelled: false`. Either order of a cancel and a reap ends
   * such a turn the same way.
   */
  readonly cancel: (address: SessionAddress, turn: number) =>
    Effect.Effect<{ readonly cancelled: boolean; readonly pending: number }, SessionMissing | SessionContended | SessionLogError>
  /**
   * Open a turn, through the host's TurnAdmission. Its writer lives in the
   * scope; a writer the scope closes unended ends with the last ending it
   * tried to store, or, when none was tried, as failed (`turn.unended`), or
   * as interrupted (`turn.interrupted`) when the scope was interrupted.
   * The input's `meta` is stored in `turn.started` and shown on the writer's
   * `admitted`; it is not part of the key's fingerprint.
   * A user's turn with `resumes: n` resumes turn `n`: it must be the
   * session's last turn begun by a user (only inbox turns, and resumes of it
   * that failed, were cancelled or were interrupted, may have run since) and
   * have ended cancelled or interrupted (reaped included), or the begin
   * fails with `NotResumable` and opens nothing. The check runs after the
   * key's (a retried resume is `TurnDuplicate`) and after `SessionBusy`, in
   * the opening commit; an `n` that is not a whole number of at least 1 is
   * `NotResumable` (`missing`) before anything else, the admission included.
   * `resumes` is stored in `turn.started`, shown on `admitted` and part of
   * the key's fingerprint.
   * A run id names one turn: a begin under one an earlier turn of the
   * session (or of the history a fork inherits) was begun with fails with
   * `RunIdReused` and opens nothing, checked in the opening commit right
   * after the key's (a retry under the same key is `TurnDuplicate`).
   * A user message is normalised first (`normalizeUserMessage`), before
   * anything else: an image its bytes do not support fails with
   * `AttachmentRejected`, and the normalised message is what is stored,
   * admitted and compared with an earlier turn of the same key.
   */
  readonly begin: (address: SessionAddress, input: BeginTurn) =>
    Effect.Effect<TurnWriter, TurnBeginError, Scope.Scope>
  /** Put an item in the inbox (once per id); `pending` counts what waits after it. */
  readonly deliver: (address: SessionAddress, item: InboxItem) =>
    Effect.Effect<{ readonly delivered: boolean; readonly pending: number }, InboxFull | SessionMissing | SessionContended | SessionLogError>
  /**
   * Run inbox turns while items wait, the session is free and the host
   * admits them, at most `maxTurns` (3), each begun with `meta`: it goes on
   * while the end of its last turn counts items waiting (ones delivered
   * during that turn included) and stops once one counts none. A turn whose
   * `run` succeeds ends completed; one whose `run` fails ends with its
   * error's code (`turnEndingOf`, a `TurnError` carried as a defect
   * included): `turn.failed`, `turn.defect` or `turn.interrupted` when it has
   * none. A `run` that interrupts itself counts an attempt for the items it
   * took, even when it wrote nothing.
   */
  readonly drain: <E, R>(address: SessionAddress, run: (writer: TurnWriter) => Effect.Effect<void, E, R>, options?: { readonly maxTurns?: number; readonly meta?: JsonObject }) =>
    Effect.Effect<{ readonly turns: number }, SessionMissing | SessionContended | SessionLogError, R>
}>()("efferent/Sessions") {}
