import { Schema } from "effect"

const Id = Schema.Trimmed.check(Schema.isNonEmpty())
const Json = Schema.Record(Schema.String, Schema.Unknown)

/** Whose journal a feed reads. The host authorizes the principal before opening one. */
export const FeedScope = Schema.Struct({ threadId: Id, principalId: Id })
export type FeedScope = typeof FeedScope.Type

/** One durable journal record, as the host's tail returns it, in sequence order. */
export const JournalRecord = Schema.Struct({
  sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  kind: Id,
  data: Json,
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
/** Sent once, after the first poll finds nothing new: the client has caught up. */
export const FeedReady = Schema.TaggedStruct("FeedReady", {})
/** Sent when the feed has been idle for the heartbeat interval. */
export const FeedHeartbeat = Schema.TaggedStruct("FeedHeartbeat", {})
export const FeedFrame = Schema.Union([FeedRecord, FeedReady, FeedHeartbeat])
export type FeedFrame = typeof FeedFrame.Type

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

/** WebSocket text frames: one JSON object per frame. */
export const SocketFrame = Schema.Union(
  [Schema.Struct({ type: Schema.Literal("record"), sequence: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))), event: Id, data: Json }),
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("heartbeat") })],
)
export type SocketFrame = typeof SocketFrame.Type

/** The first message a WebSocket client may send to resume after a cursor. */
export const SocketResume = Schema.Struct({ after: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))) })
