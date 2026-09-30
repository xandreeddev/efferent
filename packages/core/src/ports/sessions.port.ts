import { Context } from "effect"
import type { Effect, Option, Scope, Stream } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { JsonObject, SessionExists, SessionListCursor, SessionLogError, SessionLogEvent, SessionMissing } from "../session/session-log.entity.js"
import type {
  AdmittedTurn,
  BeginTurn,
  InboxFull,
  InboxItem,
  KeyConflict,
  NothingPending,
  ReservedKind,
  SessionAddress,
  SessionBusy,
  SessionPage,
  SessionView,
  TurnClosed,
  TurnDuplicate,
  TurnEnding,
  TurnRefused,
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
 * and every later write fails with `turn.closed`.
 */
export interface TurnWriter {
  readonly admitted: AdmittedTurn
  /** The `turn.started` event that opened the turn. */
  readonly started: SessionLogEvent
  /** The session's events before this turn (a fork's parent first), of the given kinds: what memory is rebuilt from. */
  readonly history: (kinds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError>
  /** A fresh durable snapshot including this turn (a fork's inherited history first). Flush queued writes before reading. */
  readonly snapshot: (kinds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<SessionLogEvent>, HarnessError>
  /** Queue events; returns once queued. */
  readonly append: (drafts: ReadonlyArray<TurnDraft>) => Effect.Effect<void, HarnessError>
  /** Run `op` in queue order (after everything queued before it). */
  readonly write: <A, E>(op: Effect.Effect<A, E>) => Effect.Effect<A, E | HarnessError>
  /**
   * Check, then append, atomically: `decide` sees the events others wrote
   * during this turn and says what to record. When someone else writes
   * before the commit, it decides again with their events.
   */
  readonly transact: <A, E>(decide: (foreign: ReadonlyArray<SessionLogEvent>) => Effect.Effect<Decision<A>, E>) => Effect.Effect<Decided<A>, E | HarnessError>
  /** Wait until everything queued so far is stored. */
  readonly flush: Effect.Effect<void, HarnessError>
  /** Seal write admission immediately, store already queued writes, then close the turn. Repeated calls share the first result. Returns pending inbox items. */
  readonly end: (ending: TurnEnding) => Effect.Effect<{ readonly pending: number }, HarnessError>
  /** Completes when someone else closed the turn; never when it ends by `end`. */
  readonly closed: Effect.Effect<TurnClosed>
}

/**
 * CONSUMPTION: sessions as hosts and turns use them, over the SessionLog a
 * host provides. One turn is open per session at a time — a second begin is
 * `SessionBusy` — and a turn's writes are refused once it is closed, on any
 * instance. The inbox holds deliveries (a background task's result) for the
 * turns that follow: whoever closes a turn, and whoever delivers, drains it.
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
    Effect.Effect<Decided<A>, E | ReservedKind | SessionMissing | SessionLogError>
  /** End exactly `turn` as cancelled, if it is the open one. */
  readonly cancel: (address: SessionAddress, turn: number) =>
    Effect.Effect<{ readonly cancelled: boolean; readonly pending: number }, SessionMissing | SessionLogError>
  /**
   * Open a turn, through the host's TurnAdmission. Its writer lives in the
   * scope; a writer the scope closes unended ends as failed (or interrupted).
   */
  readonly begin: (address: SessionAddress, input: BeginTurn) =>
    Effect.Effect<TurnWriter, SessionBusy | TurnDuplicate | KeyConflict | NothingPending | TurnRefused | SessionMissing | SessionLogError, Scope.Scope>
  /** Put an item in the inbox (once per id); `pending` counts what waits after it. */
  readonly deliver: (address: SessionAddress, item: InboxItem) =>
    Effect.Effect<{ readonly delivered: boolean; readonly pending: number }, InboxFull | SessionMissing | SessionLogError>
  /** Run inbox turns while items wait, the session is free and the host admits them, at most `maxTurns` (3). */
  readonly drain: <E, R>(address: SessionAddress, run: (writer: TurnWriter) => Effect.Effect<void, E, R>, options?: { readonly maxTurns?: number }) =>
    Effect.Effect<{ readonly turns: number }, SessionMissing | SessionLogError, R>
}>()("efferent/Sessions") {}
