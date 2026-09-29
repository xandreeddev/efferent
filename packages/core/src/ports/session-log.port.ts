import { Context } from "effect"
import type { Effect } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type {
  LeaseExpired,
  RevisionConflict,
  SessionCommit,
  SessionCommitted,
  SessionExists,
  SessionHead,
  SessionHeader,
  SessionListQuery,
  SessionLogError,
  SessionLogEvent,
  SessionMissing,
  SessionReadQuery,
} from "../session/session-log.entity.js"

/**
 * STORAGE: the session log a host provides — one append-only log per
 * session plus its head (see `session-log.entity.ts`). Everything above it
 * (turns, leases, the inbox, memory) is the sessions plugin's; a backend
 * only keeps the log, the head and the compare-and-swap, and passes
 * `sessionLogConformance`.
 */
export class SessionLog extends Context.Service<SessionLog, {
  /** Create an empty session (seq 0, revision 0). A child's parent must exist. */
  readonly create: (header: SessionHeader) => Effect.Effect<SessionHead, SessionExists | SessionMissing | SessionLogError>
  readonly head: (id: ConversationId) => Effect.Effect<SessionHead, SessionMissing | SessionLogError>
  readonly list: (query: SessionListQuery) => Effect.Effect<ReadonlyArray<SessionHead>, SessionLogError>
  readonly read: (id: ConversationId, query: SessionReadQuery) => Effect.Effect<ReadonlyArray<SessionLogEvent>, SessionMissing | SessionLogError>
  /** Append events and/or replace the state, atomically, when the revision and the clock allow. */
  readonly commit: (id: ConversationId, commit: SessionCommit) => Effect.Effect<SessionCommitted, RevisionConflict | LeaseExpired | SessionMissing | SessionLogError>
  /** Remove a session, its events and its children. Removing a missing session does nothing. */
  readonly remove: (id: ConversationId) => Effect.Effect<void, SessionLogError>
}>()("efferent/SessionLog") {}
