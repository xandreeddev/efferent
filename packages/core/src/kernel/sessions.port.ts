import { Context } from "effect"
import type { Effect, Schema, Scope } from "effect"
import type { ListenerFailed, LiveDefinition, StoredDraft, StoredEvent } from "./event.entity.js"
import type { SessionId, TurnNumber } from "./ids.entity.js"
import type { Journal, JournalStorageError, UnknownRecord } from "./journal.entity.js"
import type { InvalidSession, NewSessionInput, SessionRefused } from "./session.entity.js"

/** A session with its turn open: what a turn reads and writes. */
export interface OpenSession {
  readonly id: SessionId
  /** The open turn. */
  readonly turn: TurnNumber
  /** The stored events, in order, those this turn appended included. */
  readonly journal: Effect.Effect<ReadonlyArray<StoredEvent>, JournalStorageError>
  /**
   * Store the event at the next place of the journal, then announce it on
   * `Core` under the same name, and return it as stored. A waiting listener
   * that fails fails the append, after the event is stored. Once the turn
   * closed, an append is refused (`SessionRefused`, `NoOpenTurn`). A record
   * named under `core.` is refused (`SessionRefused`, `ReservedName`) and
   * nothing is stored: core's records are the session plugin's to write. A
   * value `stored` did not make, an object built by hand, is refused too
   * (`NotADraft`).
   */
  readonly append: (event: StoredDraft) => Effect.Effect<StoredEvent, JournalStorageError | ListenerFailed | SessionRefused>
  /**
   * Publish a live event of `definition` about this turn, on `Core`: it is
   * stored nowhere. A waiting listener that fails fails the publish. Once
   * the turn closed, a publish is refused (`SessionRefused`, `NoOpenTurn`).
   * So a part that holds the open session, a tool or a memory, needs no
   * `Core` to say what it is doing.
   */
  readonly publish: <D extends Schema.Json>(definition: LiveDefinition<D>, data: D) => Effect.Effect<void, ListenerFailed | SessionRefused>
}

/**
 * What a turn can fail with beside what its body fails with.
 *
 * @public
 */
export type TurnFailure = SessionRefused | JournalStorageError | UnknownRecord | ListenerFailed

/**
 * The rules for running sessions: one turn at a time, every stored event in
 * order, and a turn that closes on every exit of its body. A session with
 * a turn open refuses another (`SessionRefused`, `SessionBusy`), and stays
 * busy until its end was announced: it is free by the time the end reaches
 * a background listener or the host's stream, so whoever hears of
 * `core.session.turn.ended` there may start the next turn. A store
 * failure is a `JournalStorageError`, and a turn whose end cannot be stored
 * stays open, as the journal says it is.
 * `sessionsConformance` is the contract as runnable checks.
 */
export class Sessions extends Context.Service<Sessions, {
  /** Create a session and return its id. The input is decoded first: an empty owner, or a parent that is no id, is refused (`InvalidSession`) and stores nothing. */
  readonly create: (input: NewSessionInput) => Effect.Effect<SessionId, InvalidSession | JournalStorageError>
  /** The session's header and stored events. */
  readonly read: (id: SessionId) => Effect.Effect<Journal, JournalStorageError>
  /**
   * Open the session's next turn in the current scope, and close it when the
   * scope closes. Opening stores `core.session.turn.started`; the close stores
   * `core.session.turn.ended` with the outcome the scope closes with (a
   * success completes the turn, a failure fails it, an interrupt interrupts
   * it) and frees the session. A scope's close cannot fail: an end that
   * cannot be stored is a defect of the scope, and the turn stays open, as
   * the journal says. `turn` returns that failure as it is. A journal
   * written in another format than this kernel's is refused
   * (`SessionRefused`, `FormatMismatch`) and nothing is stored: `read` still
   * gives it, so a host can say what it found.
   */
  readonly open: (id: SessionId) => Effect.Effect<OpenSession, TurnFailure, Scope.Scope>
  /**
   * Run `body` as the session's next turn: `open` in a scope of its own, the
   * body, and the close with the body's exit. Every exit of the body (its
   * value, its failure, an interrupt) stores `core.session.turn.ended` with
   * the outcome and frees the session.
   */
  readonly turn: <A, E, R>(id: SessionId, body: (session: OpenSession) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | TurnFailure, R>
}>()("@xandreed/core/kernel/Sessions") {}
