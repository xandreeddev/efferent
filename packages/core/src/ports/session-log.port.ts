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
  JsonObject,
  SessionRef,
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
 * `sessionLogConformance`. One event can be large: a user's images are
 * stored inline in its `turn.started`, up to `MEDIA_LIMITS.requestChars`
 * base64 characters together, so a backend must hold an event of that size
 * (the kit checks one).
 */
export class SessionLog extends Context.Service<SessionLog, {
  /** Create an empty session (seq 0, revision 0), as a new incarnation. A child's parent must exist. */
  readonly create: (input: { readonly header: SessionHeader; readonly state: JsonObject }) => Effect.Effect<SessionHead, SessionExists | SessionMissing | SessionLogError>
  readonly head: (id: ConversationId) => Effect.Effect<SessionHead, SessionMissing | SessionLogError>
  readonly list: (query: SessionListQuery) => Effect.Effect<ReadonlyArray<SessionHead>, SessionLogError>
  readonly read: (session: SessionRef, query: SessionReadQuery) => Effect.Effect<ReadonlyArray<SessionLogEvent>, SessionMissing | SessionLogError>
  /** Append events and/or replace the state, atomically, when the revision, the clock and the incarnation allow. */
  readonly commit: (session: SessionRef, commit: SessionCommit) => Effect.Effect<SessionCommitted, RevisionConflict | LeaseExpired | SessionMissing | SessionLogError>
  /** Remove a session, its events and its children. A stale or missing reference fails with SessionMissing. */
  readonly remove: (session: SessionRef) => Effect.Effect<void, SessionMissing | SessionLogError>
}>()("efferent/SessionLog") {}
