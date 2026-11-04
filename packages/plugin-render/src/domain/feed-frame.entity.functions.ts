import { Result, Match, Option, Schema } from "effect"
import { FeedHeartbeat, FeedReady, FeedRecord, FeedTransient, SocketFrame, SocketResume, SseRecordFields, SseTransientFields } from "./feed-frame.entity.js"
import type { FeedFrame, FeedOptions, FeedPayload } from "./feed-frame.entity.js"
import { RenderError } from "./render-surface.entity.js"

/**
 * SSE wire format, one block per frame:
 * - once per connection: `retry: 1000`
 * - record:    `id: <sequence>` `event: <event>` `data: <json>`
 * - transient: `event: <event>` `data: <json>` (no `id`)
 * - ready:     `event: ready` `data: {}`
 * - heartbeat: `: heartbeat` (a comment)
 * Clients resume by sending `Last-Event-ID: <sequence>`. A block without an
 * `id` leaves an `EventSource`'s last event id as it was, so a transient
 * frame never moves the cursor.
 */
export const ssePreamble = "retry: 1000\n\n"

export const encodeSse = (frame: FeedFrame): string => Match.valueTags(frame, {
  FeedRecord: (record) => `id: ${record.sequence}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`,
  FeedTransient: (transient) => `event: ${transient.event}\ndata: ${JSON.stringify(transient.data)}\n\n`,
  FeedReady: () => "event: ready\ndata: {}\n\n",
  FeedHeartbeat: () => ": heartbeat\n\n",
})

const fieldsOf = (block: string): ReadonlyMap<string, string> => new Map(block.split("\n").flatMap((line) => {
  const colon = line.indexOf(":")
  return colon <= 0 ? [] : [[line.slice(0, colon), line.slice(colon + 1).trimStart()] as const]
}))

const decodeRecordFields = Schema.decodeUnknownResult(SseRecordFields)
const decodeTransientFields = Schema.decodeUnknownResult(SseTransientFields)

/**
 * A block of comments or of `retry` alone carries no frame; any other block must be a frame `encodeSse` writes:
 * with an `id`, a record (whatever its event); without one, `ready` or a transient frame.
 */
const decodeSseBlock = (block: string): Result.Result<ReadonlyArray<FeedFrame>, RenderError> => {
  if (block.startsWith(": heartbeat")) return Result.succeed([FeedHeartbeat.make({})])
  const fields = fieldsOf(block)
  if (!["id", "event", "data"].some((name) => fields.has(name))) return Result.succeed([])
  if (fields.has("id")) {
    return decodeRecordFields(Object.fromEntries(fields)).pipe(
      Result.map((record): ReadonlyArray<FeedFrame> => [FeedRecord.make({ sequence: record.sequence, event: record.event, data: record.data })]),
      Result.mapError((error) => new RenderError({ code: "invalid", message: `Invalid SSE record: ${error.message}` })),
    )
  }
  if (fields.get("event") === "ready") return Result.succeed([FeedReady.make({})])
  return decodeTransientFields(Object.fromEntries(fields)).pipe(
    Result.map((transient): ReadonlyArray<FeedFrame> => [FeedTransient.make({ event: transient.event, data: transient.data })]),
    Result.mapError((error) => new RenderError({ code: "invalid", message: `Invalid SSE transient frame: ${error.message}` })),
  )
}

/** The inverse of `encodeSse` over a whole stream, for clients and tests; a malformed record or transient frame fails with `invalid`. */
export const decodeSse = (text: string): Result.Result<ReadonlyArray<FeedFrame>, RenderError> =>
  Result.all(text.split("\n\n").filter((block) => block.length > 0).map(decodeSseBlock)).pipe(Result.map((blocks) => blocks.flat()))

export const encodeSocketFrame = (frame: FeedFrame): string => JSON.stringify(Match.valueTags(frame, {
  FeedRecord: (record): SocketFrame => ({ type: "record", sequence: record.sequence, event: record.event, data: record.data }),
  FeedTransient: (transient): SocketFrame => ({ type: "transient", event: transient.event, data: transient.data }),
  FeedReady: (): SocketFrame => ({ type: "ready" }),
  FeedHeartbeat: (): SocketFrame => ({ type: "heartbeat" }),
}))

/** @public */
export const decodeSocketFrame = (text: string): Option.Option<FeedFrame> =>
  Result.getSuccess(Schema.decodeUnknownResult(Schema.fromJsonString(SocketFrame))(text)).pipe(Option.map((frame): FeedFrame =>
    Match.value(frame).pipe(Match.discriminatorsExhaustive("type")({
      record: (record): FeedFrame => FeedRecord.make({ sequence: record.sequence, event: record.event, data: record.data }),
      transient: (transient): FeedFrame => FeedTransient.make({ event: transient.event, data: transient.data }),
      ready: (): FeedFrame => FeedReady.make({}),
      heartbeat: (): FeedFrame => FeedHeartbeat.make({}),
    }))))

const decodeTransient = Schema.decodeUnknownResult(FeedTransient)

/** A live payload as a transient frame; `ready`, the feed's own frame, is refused with `invalid`. */
export const transientOf = (payload: FeedPayload): Result.Result<FeedTransient, RenderError> =>
  decodeTransient({ _tag: "FeedTransient", event: payload.event, data: payload.data }).pipe(
    Result.mapError((error) => new RenderError({ code: "invalid", message: `Invalid live frame: ${error.message}` })))

/**
 * The cursor a WebSocket client asks to resume after (`{"after": n}`).
 *
 * @public
 */
export const socketResumeOf = (text: string): Option.Option<number> =>
  Result.getSuccess(Schema.decodeUnknownResult(Schema.fromJsonString(SocketResume))(text)).pipe(Option.map((resume) => resume.after))

/**
 * Back off while idle; poll promptly again once records arrive.
 *
 * @public
 */
export const nextPollMs = (current: number, options: FeedOptions, received: boolean): number =>
  received ? options.pollMs : Math.min(options.maxPollMs, Math.max(options.pollMs, current * 2))
