import { Schema } from "effect"
import { PrincipalId, ThreadId } from "./render-output.entity.js"

const Id = Schema.Trimmed.check(Schema.isNonEmpty())
/** A record's payload: a JSON object, every value JSON. */
const Json = Schema.JsonObject

/**
 * Whose journal a feed reads. The host authorizes the principal before opening one.
 *
 * @public
 */
export const FeedScope = Schema.Struct({ threadId: ThreadId, principalId: PrincipalId })
export type FeedScope = typeof FeedScope.Type

/**
 * One durable journal record, as the host's tail returns it, in sequence order.
 *
 * @public
 */
export const JournalRecord = Schema.Struct({
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  kind: Id,
  data: Json,
  /** The turn the record belongs to, when the journal has turns (a session's does; null outside a turn). */
  turn: Schema.optional(Schema.NullOr(Schema.Int)),
})
export type JournalRecord = typeof JournalRecord.Type

/** What a projection makes of a record: the event name and payload a client receives. */
export const FeedPayload = Schema.Struct({ event: Id, data: Json })
export type FeedPayload = typeof FeedPayload.Type

export const FeedRecord = Schema.TaggedStruct("FeedRecord", {
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  event: Id,
  data: Json,
})
/**
 * A live frame with no sequence: something a client sees as it happens but
 * the journal never stores (a reply as it streams, a preview, a build
 * handshake). It carries no cursor, so it never moves a client's resume
 * point; a reconnecting client gets only what the journal kept. Its event
 * may not be `ready`, the feed's own frame.
 *
 * @public
 */
export const FeedTransient = Schema.TaggedStruct("FeedTransient", {
  event: Id.check(Schema.makeFilter((event) => event !== "ready" || "a transient frame may not be named ready, the feed's own frame")),
  data: Json,
})
export type FeedTransient = typeof FeedTransient.Type
/** Sent once, after the first poll finds nothing new: the client has caught up. */
export const FeedReady = Schema.TaggedStruct("FeedReady", {})
/** Sent when the feed has been idle for the heartbeat interval. */
export const FeedHeartbeat = Schema.TaggedStruct("FeedHeartbeat", {})
/** @public */
export const FeedFrame = Schema.Union([FeedRecord, FeedTransient, FeedReady, FeedHeartbeat])
export type FeedFrame = typeof FeedFrame.Type

/**
 * The fields of one SSE record block, as text: the wire's `id` is the record's sequence, `data` its JSON.
 *
 * @public
 */
export const SseRecordFields = Schema.Struct({
  sequence: Schema.NumberFromString.pipe(Schema.decodeTo(FeedRecord.fields.sequence)),
  event: FeedRecord.fields.event,
  data: Schema.fromJsonString(FeedRecord.fields.data),
}).pipe(Schema.encodeKeys({ sequence: "id" }))

/** The fields of one SSE transient block, as text: an `event` and its JSON `data`, and no `id`. */
export const SseTransientFields = Schema.Struct({
  event: FeedTransient.fields.event,
  data: Schema.fromJsonString(FeedTransient.fields.data),
})

export const FeedOptions = Schema.Struct({
  /** Poll interval after new records. */
  pollMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  /** Upper bound the idle interval backs off to. */
  maxPollMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  heartbeatMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  /** The feed ends after this long; clients reconnect with their cursor. */
  maxDurationMs: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
})
export type FeedOptions = typeof FeedOptions.Type

/**
 * WebSocket text frames: one JSON object per frame.
 *
 * @public
 */
export const SocketFrame = Schema.Union(
  [Schema.Struct({ type: Schema.Literal("record"), sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))), event: Id, data: Json }),
  Schema.Struct({ type: Schema.Literal("transient"), event: FeedTransient.fields.event, data: Json }),
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("heartbeat") })],
)
export type SocketFrame = typeof SocketFrame.Type

/**
 * The first message a WebSocket client may send to resume after a cursor.
 *
 * @public
 */
export const SocketResume = Schema.Struct({ after: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))) })
