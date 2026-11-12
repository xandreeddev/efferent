import { Context } from "effect"
import type { Effect } from "effect"
import type { ListenerFailed, StoredDraft, StoredEvent } from "./event.entity.js"
import type { SessionId, TurnNumber } from "./ids.entity.js"
import type { Journal, StorageError, UnknownRecord } from "./journal.entity.js"
import type { NewSession, SessionRefused } from "./session.entity.js"

/** A session with its turn open: what a turn reads and writes. */
export interface OpenSession {
  readonly id: SessionId
  /** The open turn. */
  readonly turn: TurnNumber
  /** The stored events, in order, those this turn appended included. */
  readonly journal: Effect.Effect<ReadonlyArray<StoredEvent>, StorageError>
  /**
   * Store the event at the next place of the journal, then announce it on
   * `Core` under the same name, and return it as stored. A waiting listener
   * that fails fails the append, after the event is stored. Once the turn
   * closed, an append is refused (`SessionRefused`, `NoOpenTurn`).
   */
  readonly append: (event: StoredDraft) => Effect.Effect<StoredEvent, StorageError | ListenerFailed | SessionRefused>
}

/**
 * What a turn can fail with beside what its body fails with.
 *
 * @public
 */
export type TurnFailure = SessionRefused | StorageError | UnknownRecord | ListenerFailed

/**
 * The rules for running sessions: one turn at a time, every stored event in
 * order, and a turn that closes on every exit of its body. A session with
 * a turn open refuses another (`SessionRefused`, `SessionBusy`), and stays
 * busy until its end was announced; storage failures are `StorageError`s,
 * and a turn whose end cannot be stored stays open, as the journal says it
 * is.
 * `sessionsConformance` is the contract as runnable checks.
 */
export class Sessions extends Context.Service<Sessions, {
  /** Create a session and return its id. */
  readonly create: (input: NewSession) => Effect.Effect<SessionId, StorageError>
  /** The session's header and stored events. */
  readonly read: (id: SessionId) => Effect.Effect<Journal, StorageError>
  /**
   * Run `body` as the session's next turn. Opening stores
   * `plugin.session.turn.started`; every exit of the body (its value, its
   * failure, an interrupt) stores `plugin.session.turn.ended` with the
   * outcome and frees the session.
   */
  readonly turn: <A, E, R>(id: SessionId, body: (session: OpenSession) => Effect.Effect<A, E, R>) => Effect.Effect<A, E | TurnFailure, R>
}>()("@xandreed/core/kernel/Sessions") {}
