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

/**
 * A JSON object as stored: compared by value, key order is not kept. Every
 * value is JSON (`Schema.JsonObject`), so a reader decodes what it reads
 * rather than narrowing `unknown` by hand.
 */
export const JsonObject = Schema.JsonObject
export type JsonObject = Schema.JsonObject

/**
 * Which life of a session a head belongs to: the store gives a new one each
 * time it creates a session, so a session removed and created again under
 * its id is another incarnation. Stable for that life, whichever handle or
 * process reads it. A commit that names one (`SessionCommit.incarnation`)
 * lands only in that incarnation.
 */
export const SessionIncarnation = Schema.String.pipe(Schema.brand("SessionIncarnation"))
export type SessionIncarnation = typeof SessionIncarnation.Type

/** An exact owner-qualified life of a session; required for every data operation. @public */
export const SessionRef = Schema.Struct({ id: ConversationId, owner: Name, incarnation: SessionIncarnation })
export type SessionRef = typeof SessionRef.Type

/**
 * Where a forked session starts: the parent, the last parent event it
 * inherits, and the parent's turns at that point.
 *
 * @public
 */
export const SessionLineage = Schema.Struct({
  ...SessionRef.fields,
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

/** A session's head: the header, its incarnation, the last sequence number, the revision and the plugin's state. */
export const SessionHead = Schema.Struct({
  header: SessionHeader,
  incarnation: SessionIncarnation,
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
 * One atomic commit: accepted only while the head's revision is `expect`,
 * the storage clock is at most `notAfter` (when given) and the session is
 * still the owner and `incarnation` of its mandatory SessionRef (one removed and
 * created again under its id is `SessionMissing` to it, and nothing is
 * written, whatever its revision). `state`, when given, replaces the head's
 * state; `events` may be empty.
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

/**
 * Events after `after` and at most `through`, ascending; filter by kind
 * before limiting. `from` picks which end of that range `limit` keeps.
 */
export const SessionReadQuery = Schema.Struct({
  after: Schema.Int,
  /** Inclusive sequence ceiling, applied before logical payload decoding or media hydration. Omission reads the current tail. */
  through: Schema.optionalKey(Schema.Int),
  limit: Schema.OptionFromNullOr(Schema.Int),
  kinds: Schema.Array(Name),
  /**
   * The end of the range `limit` counts from. `start`: the oldest `limit`
   * matching events. `end`: the newest `limit` matching events (kinds
   * filtered first, at most `through`, after `after`), so a reader of the
   * latest records of a few kinds does not scan the session from its
   * start. Either way the events come back ascending; without a limit,
   * every match. Omission reads from the start.
   */
  from: Schema.optionalKey(Schema.Literals(["start", "end"])),
  /**
   * `references`: the caller decodes only lookup keys, so a decorating store
   * (`withMediaStore`) may leave stored media references in place instead of
   * reading their bytes. A plain backend ignores it. Omission hydrates.
   */
  media: Schema.optionalKey(Schema.Literals(["hydrate", "references"])),
})
export type SessionReadQuery = typeof SessionReadQuery.Type

/**
 * A position in a listing: strictly older sessions come after it.
 *
 * @public
 */
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
  parent: Schema.OptionFromNullOr(SessionRef),
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

/**
 * The store itself failed (unreachable, busy, undecodable): `code` says how
 * (`store.busy`: `isStoreBusy`), `cause` is the store's own failure, when
 * there is one.
 */
export class SessionLogError extends Schema.TaggedError<SessionLogError>()("SessionLogError", {
  code: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
