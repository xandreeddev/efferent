import { Context } from "effect"
import type { Effect, Option, Scope, Stream } from "effect"
import type { AttachmentRejected } from "../domain/media.entity.js"
import type { ConversationId } from "../domain/message.entity.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { TurnEnding } from "../domain/turn-vocabulary.entity.js"
import type { JsonObject, SessionExists, SessionListCursor, SessionLogError, SessionLogEvent, SessionMissing, SessionReadQuery } from "../session/session-log.entity.js"
import type {
  AdmittedTurn,
  BeginTurn,
  InboxFull,
  InboxItem,
  InputConflict,
  QueuedInput,
  ReservedKind,
  SessionAddress,
  SessionContended,
  SessionPage,
  SessionView,
  TransactConflict,
  TransactDuplicate,
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
 * What makes a `Sessions.transact` idempotent: a host action retried (a
 * request sent again after a timeout) records once.
 */
export interface TransactOptions {
  /**
   * The host's idempotency key (a request or command id). Its first
   * transact stores it, in the same commit as the decision's events; a
   * later one under it does not decide again. Transact keys are the
   * session's own, apart from the keys turns are begun with.
   */
  readonly key: string
  /** What the request asked for, the key's fingerprint, compared as canonical JSON (`{}` when left out). */
  readonly command?: JsonObject
}

/**
 * What a transact given these options adds to its failures: a keyed one's
 * refusals of a repeat (`TransactDuplicate`, `TransactConflict`), none
 * without a key.
 */
export type TransactRefusal<O> = O extends TransactOptions ? TransactDuplicate | TransactConflict : never

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
 * later write and flush with that error. `append`, `transact` and `closing`
 * refuse a draft under one of the framework's kinds (`RESERVED_KINDS`) with
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
  /** Optional atomic snapshot-pointer capability: the selected visible publication row, never a future fork row. */
  readonly memorySnapshot?: Effect.Effect<Option.Option<SessionLogEvent>, TurnError>
  /** Fresh pending delivery:steer inputs in delivery order; never claims one or records a notice attempt. */
  readonly steers: Effect.Effect<ReadonlyArray<QueuedInput>, TurnError>
  /**
   * Atomically record the prepared inbox-marked user messages and one
   * inbox.taken receipt per input, removing those waiting steer slots in
   * the same durable commit. Every message must match its immutable input
   * and this turn. True means the whole batch committed; false means a
   * stale or ineligible selection and no entries committed. A false take
   * must not advance the caller's memory ids. Duplicate/invalid entries
   * fail as a TurnError. A taken steer is acknowledged even if this turn
   * later fails; replay already has its user message.
   */
  readonly take: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<boolean, TurnError>
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
  /** Wait until everything queued so far is stored (never the closing drafts: the end stores them). */
  readonly flush: Effect.Effect<void, TurnError>
  /**
   * Hold the turn's closing drafts (the framework's turn holds its reply,
   * `turn.reply`, and what memory records after it): they are stored only in
   * the end's own commit, directly before `turn.ended`, so a turn is never
   * stored replied but not ended. A later call replaces them; `flush` does
   * not store them; a close from elsewhere (a cancel, a reap, a removal)
   * discards them. Refused as `append` is (`ReservedKind`, `TurnClosed`
   * once the end is under way), and, held, counts as a write of the turn.
   */
  readonly closing: (drafts: ReadonlyArray<TurnDraft>) => Effect.Effect<void, TurnError>
  /**
   * Close the turn: one commit stores the held closing drafts (`closing`),
   * then `turn.ended`, after every write queued before it. It is admitted
   * like a write (so it waits while one waits for room in a full queue);
   * from then on `append`, `write`, `transact` and `closing` are refused,
   * and `flush` still waits for what is queued. Calls while it runs share
   * its result. A stored end, or a turn closed elsewhere, is final; after
   * any other failure (a store error) writes are admitted again, the
   * closing drafts still held, and a later end, the scope's own at the
   * latest, tries again: the scope's with the last ending whose commit was
   * tried. Returns how many inbox items wait.
   */
  readonly end: (ending: TurnEnding) => Effect.Effect<{ readonly pending: number }, TurnError>
  /** Completes when someone else closed the turn (never with `ended`); never when it ends by `end`. */
  readonly closed: Effect.Effect<TurnClosed>
  /**
   * Optional capability: seal the turn once its reply is held (`closing`)
   * and final. The held reply must imply a completed or partial ending
   * (`replyEndingOf`); otherwise nothing is sealed and the answer is none.
   * Sealing stores, in its own commit, that the open turn is sealed with that
   * ending and the closing drafts held then (the reply's), so whoever closes
   * it while it is still open ends it so, with that reply, instead of
   * interrupting it: its own `end` whatever ending it is given, its scope's
   * end, a cancel, its time limit and a shutdown on this instance (each
   * storing the closing drafts still held), and a cancel elsewhere, a reap
   * or a takeover once its holder is gone (each storing the drafts sealed;
   * what the holder held only after the seal is lost). Writes are admitted
   * until the end. The answer, when
   * sealed, completes once someone else stored that end, so the work the
   * turn does after its reply can stop.
   */
  readonly seal?: Effect.Effect<Option.Option<Effect.Effect<void>>, TurnError>
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
 *
 * Every call that names a session takes its `SessionAddress` (id and
 * owner): another owner's address is `SessionMissing`. An address that also
 * carries an `incarnation` (a `SessionRef`: `SessionView.incarnation` with
 * the id and owner, `AdmittedTurn.session`, `TurnToAdmit.session`) is fenced
 * to that life of the session: once it is removed and created again under
 * its id, the address is `SessionMissing`, so a host that keeps it acts on
 * the session it read and never on its replacement. An address without one
 * names whichever session holds the id for that owner at each call; one call
 * keeps the session it resolved first (a drain all its turns).
 */
export class Sessions extends Context.Service<Sessions, {
  /**
   * Instance-wide broadcast rescan signal: an initial signal after each
   * subscription, then local commits that change what a drainer acts on
   * (an inbox item added, claimed, released, taken or done; a turn opened
   * or closed; a session created or removed). A turn's own appends signal
   * nothing. Slow subscribers coalesce signals. Payloads carry no addresses
   * or authority; foreign commits need a sweep.
   */
  readonly waiting: Stream.Stream<void>
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
  /**
   * The session's own events after `after` (0), of `kinds` (all), ascending.
   * `limit` keeps the oldest matches, or with `from: "end"` the newest
   * (kinds filtered first), still ascending: the latest records of a few
   * kinds without reading the session from its start.
   */
  readonly read: (address: SessionAddress, query?: {
    readonly after?: number
    readonly kinds?: ReadonlyArray<string>
    readonly limit?: number
    readonly from?: SessionReadQuery["from"]
  }) => Effect.Effect<ReadonlyArray<SessionLogEvent>, SessionMissing | SessionLogError>
  /**
   * At least one signal after each commit this instance makes; signals not
   * yet taken merge into one. A follower is woken only by its own session's
   * commits, from its first pull on, and holds at most one signal while it
   * does not pull: a signal says "read again", never how many commits came
   * (followers poll for the commits of other instances).
   */
  readonly changes: (address: SessionAddress) => Stream.Stream<void>
  /** The turn begun with this key, if any. */
  readonly lookup: (address: SessionAddress, key: string) => Effect.Effect<Option.Option<number>, SessionMissing | SessionLogError>
  /**
   * Check, then append outside a turn (a user's action on a page, a
   * setting), beside an open turn too: decided again on a conflict. With a
   * `key` (`TransactOptions`), the commit that records the decision also
   * stores the key and its `command` (`transact.keyed`, before the
   * decision's events), so a retried action records once: a later transact
   * under the key, on any instance, calls no `decide` and writes nothing,
   * failing with `TransactDuplicate` (the first one's `events`) when its
   * `command` is the same and `TransactConflict` when it is not. Of
   * transacts racing under one key, exactly one commits. A decision that
   * fails, or is refused (`ReservedKind`), stores no key. `Decided.events`
   * are the decision's own, never the key's record.
   */
  readonly transact: <A, E, O extends TransactOptions | undefined = undefined>(address: SessionAddress, decide: (view: SessionView) => Effect.Effect<Decision<A>, E>, options?: O) =>
    Effect.Effect<Decided<A>, E | ReservedKind | TransactRefusal<O> | SessionMissing | SessionContended | SessionLogError>
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
   * scope; a writer the scope closes unended ends, its closing drafts stored
   * with it, with the last ending it tried to store, or, when none was
   * tried, the one its held reply implies (`replyEndingOf`: completed or
   * partial), else as failed (`turn.unended`), or as interrupted
   * (`turn.interrupted`) when the scope was interrupted.
   * The input's `meta` is stored in `turn.started` and shown on the writer's
   * `admitted`; it is not part of the key's fingerprint.
   * A task's turn (`Task`, origin `task`) is keyed like a user's, its task
   * (`TaskRef`) part of the fingerprint, stored in `turn.started` and shown
   * on `admitted` and to the host's admission; it cannot be resumed
   * (`NotResumable`, `task`).
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
   * A queued turn (`Queued`) atomically claims exactly the named queued
   * input as a user's turn: its first key is `input:<id>`, later attempts
   * use fresh keys. No eligible input is `NothingPending`; an acknowledged
   * input is `TurnDuplicate`. The queued identity is stored and admitted;
   * an explicit user resume of it reclaims the same pending input so a
   * successful resume cannot leave it to run again.
   * A user message is normalised first (`normalizeUserMessage`), before
   * anything else: an image its bytes do not support fails with
   * `AttachmentRejected`, and the normalised message is what is stored,
   * admitted and compared with an earlier turn of the same key.
   */
  readonly begin: (address: SessionAddress, input: BeginTurn) =>
    Effect.Effect<TurnWriter, TurnBeginError, Scope.Scope>
  /**
   * Store a normalized user input once per id, including its attachments.
   * An id with another message, delivery or source is InputConflict; a
   * repeated identical input is acknowledged even after its turn completed.
   * Queued inputs survive failed, partial and interrupted turns without an
   * attempt ceiling. Completion or explicit cancellation acknowledges them.
   */
  readonly enqueue: (address: SessionAddress, input: QueuedInput) =>
    Effect.Effect<{ readonly enqueued: boolean; readonly pending: number }, AttachmentRejected | InputConflict | InboxFull | SessionMissing | SessionContended | SessionLogError>
  /** Put a legacy notice in the inbox (once per id); `pending` counts every kind of input waiting after it. */
  readonly deliver: (address: SessionAddress, item: InboxItem) =>
    Effect.Effect<{ readonly delivered: boolean; readonly pending: number }, InboxFull | SessionMissing | SessionContended | SessionLogError>
  /**
   * Run selected pending work while the session is free and the host
   * admits it, at most `maxTurns` (3), each turn begun with `meta`. `take`
   * is all by default, inputs for queued user input only, or notices for
   * legacy notices only. Every queued input starts its own user turn with
   * its exact message and attachments; an inbox turn takes notices only.
   * A queued input is also reclaimed by an explicit user resume and
   * acknowledged once that resume completes. The drain continues while
   * selected items wait, including ones delivered during its last turn.
   * A successful `run` preserves the outcome of its held reply (completed
   * or partial), and ends completed when it held none. A failed `run` ends with its
   * error's code (`turnEndingOf`, a `TurnError` carried as a defect
   * included): `turn.failed`, `turn.defect` or `turn.interrupted` when it has
   * none. A `run` that interrupts itself counts an attempt for the items it
   * took, even when it wrote nothing. With `takeOver`, the drain's first
   * turn begins as `BeginTurn`'s `takeOver` says: a turn left open by a
   * holder the host knows is gone is closed at once (`turn.takeover`)
   * instead of waiting for its lease. Its later turns never take over: a
   * turn begun between them is live work, and the drain stops at it. With `timeLimitMs`, each turn may run that long
   * (`BeginTurn`'s `timeLimitMs`), its `run` interrupted past it.
   */
  readonly drain: <E, R>(address: SessionAddress, run: (writer: TurnWriter) => Effect.Effect<void, E, R>, options?: { readonly maxTurns?: number; readonly meta?: JsonObject; readonly takeOver?: boolean; readonly timeLimitMs?: number; readonly take?: "all" | "inputs" | "notices" }) =>
    Effect.Effect<{ readonly turns: number }, SessionMissing | SessionContended | SessionLogError, R>
}>()("efferent/Sessions") {}
