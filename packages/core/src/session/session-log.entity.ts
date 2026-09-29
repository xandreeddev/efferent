import { Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"

/*
 * The session log: one append-only log of events per session, and a head
 * row beside it. It is the low level a host provides (a database, a file,
 * memory) and it knows nothing about turns, memory or leases: the head
 * carries an opaque `state` that the sessions plugin owns, and every commit
 * is a compare-and-swap on the head's `revision`. The storage clock is the
 * only clock: event times, `updatedAt`, `now` and the `notAfter` check.
 */

const Name = Schema.Trimmed.check(Schema.isNonEmpty())

/** A JSON object as stored: compared by value, key order is not kept. */
export const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
export type JsonObject = typeof JsonObject.Type

/** Where a forked session starts: the parent, the last parent event it inherits, and the parent's turns at that point. */
export const SessionLineage = Schema.Struct({
  id: ConversationId,
  through: Schema.Int,
  turnAtFork: Schema.Int,
})
export type SessionLineage = typeof SessionLineage.Type

/** What a session is, fixed when it is created. */
export const SessionHeader = Schema.Struct({
  id: ConversationId,
  /** Every read and write names the owner; another owner sees no session. */
  owner: Name,
  /** Who opened it: `user` for a conversation, `task` for a background task, or a host's own kind. */
  origin: Name,
  createdAt: Schema.Number,
  meta: JsonObject,
  parent: Schema.OptionFromNullOr(SessionLineage),
})
export type SessionHeader = typeof SessionHeader.Type

/** A session's head: the header, the last sequence number, the revision and the plugin's state. */
export const SessionHead = Schema.Struct({
  header: SessionHeader,
  /** The last event's sequence number; 0 before any event. */
  seq: Schema.Int,
  /** Bumped by exactly one on every commit, events or not. */
  revision: Schema.Int,
  state: JsonObject,
  updatedAt: Schema.Number,
  /** The storage clock when the head was read. */
  now: Schema.Number,
})
export type SessionHead = typeof SessionHead.Type

/** An event to append; the log assigns its sequence number and time. */
export const SessionDraft = Schema.Struct({
  kind: Name,
  turn: Schema.OptionFromNullOr(Schema.Int),
  data: JsonObject,
})
export type SessionDraft = typeof SessionDraft.Type

/** One stored event. */
export const SessionLogEvent = Schema.Struct({
  session: ConversationId,
  /** Dense from 1 within the session. */
  seq: Schema.Int,
  turn: Schema.OptionFromNullOr(Schema.Int),
  kind: Name,
  at: Schema.Number,
  data: JsonObject,
})
export type SessionLogEvent = typeof SessionLogEvent.Type

/**
 * One atomic commit: accepted only while the head's revision is `expect`
 * and the storage clock is at most `notAfter` (when given). `state`, when
 * given, replaces the head's state; `events` may be empty.
 */
export const SessionCommit = Schema.Struct({
  expect: Schema.Int,
  notAfter: Schema.OptionFromNullOr(Schema.Number),
  events: Schema.Array(SessionDraft),
  state: Schema.OptionFromNullOr(JsonObject),
})
export type SessionCommit = typeof SessionCommit.Type

/** What a commit stored: the new revision, the events as stored, and the storage time. */
export const SessionCommitted = Schema.Struct({
  revision: Schema.Int,
  seq: Schema.Int,
  events: Schema.Array(SessionLogEvent),
  at: Schema.Number,
})
export type SessionCommitted = typeof SessionCommitted.Type

/** Events after `after`, ascending; only the given kinds when any are named. */
export const SessionReadQuery = Schema.Struct({
  after: Schema.Int,
  limit: Schema.OptionFromNullOr(Schema.Int),
  kinds: Schema.Array(Name),
})
export type SessionReadQuery = typeof SessionReadQuery.Type

/** A position in a listing: strictly older sessions come after it. */
export const SessionListCursor = Schema.Struct({ updatedAt: Schema.Number, id: ConversationId })
export type SessionListCursor = typeof SessionListCursor.Type

/**
 * An owner's sessions, most recently updated first (then by id, descending).
 * With `parent`, that session's children; without, only top-level sessions.
 */
export const SessionListQuery = Schema.Struct({
  owner: Name,
  limit: Schema.Int,
  before: Schema.OptionFromNullOr(SessionListCursor),
  parent: Schema.OptionFromNullOr(ConversationId),
})
export type SessionListQuery = typeof SessionListQuery.Type

export class SessionMissing extends Schema.TaggedError<SessionMissing>()("SessionMissing", {
  session: ConversationId,
}) {}

export class SessionExists extends Schema.TaggedError<SessionExists>()("SessionExists", {
  session: ConversationId,
}) {}

/** The head moved on since the writer read it; nothing was written. */
export class RevisionConflict extends Schema.TaggedError<RevisionConflict>()("RevisionConflict", {
  session: ConversationId,
  expected: Schema.Int,
  actual: Schema.Int,
}) {}

/** The storage clock passed the commit's `notAfter`; nothing was written. */
export class LeaseExpired extends Schema.TaggedError<LeaseExpired>()("LeaseExpired", {
  session: ConversationId,
  notAfter: Schema.Number,
  now: Schema.Number,
}) {}

/** The store itself failed (unreachable, undecodable). */
export class SessionLogError extends Schema.TaggedError<SessionLogError>()("SessionLogError", {
  code: Schema.String,
  message: Schema.String,
}) {}
