import { Context } from "effect"
import type { Effect } from "effect"
import type { EventDraft } from "./event.entity.js"
import type { SessionId, TurnNumber } from "./ids.entity.js"
import type { StorageError, StoredEvent } from "./journal.entity.js"
import type { SessionRefused } from "./session.entity.js"

/**
 * A session with its turn open: what a turn reads and writes.
 *
 * @public
 */
export interface OpenSession {
  readonly id: SessionId
  /** The open turn. */
  readonly turn: TurnNumber
  /** The stored events, in order, those this turn recorded included. */
  readonly journal: Effect.Effect<ReadonlyArray<StoredEvent>, StorageError>
  /** Stamp the event with the next place and the time, append it and return it as stored. */
  readonly record: (event: EventDraft) => Effect.Effect<StoredEvent, StorageError>
}

/**
 * The rules for running sessions: one turn at a time. A session with a turn
 * open refuses another (`SessionRefused`, `SessionBusy`); storage failures
 * are `StorageError`s.
 *
 * @public
 */
export class Sessions extends Context.Service<Sessions, {
  /** Read the session's journal and open its next turn. */
  readonly open: (id: SessionId) => Effect.Effect<OpenSession, SessionRefused | StorageError>
  /** Close the session's open turn, leaving the session free. */
  readonly close: (session: OpenSession) => Effect.Effect<void, SessionRefused | StorageError>
}>()("@xandreed/core/kernel/Sessions") {}
