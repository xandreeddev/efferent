import { Result, Match, Option, Schema } from "effect"
import { FeedHeartbeat, FeedReady, FeedRecord, SocketFrame, SocketResume, SseRecordFields } from "./feed-frame.entity.js"
import type { FeedFrame, FeedOptions } from "./feed-frame.entity.js"
import { RenderError } from "./render-surface.entity.js"

/**
 * SSE wire format, one block per frame:
 * - once per connection: `retry: 1000`
 * - record:    `id: <sequence>` `event: <event>` `data: <json>`
 * - ready:     `event: ready` `data: {}`
 * - heartbeat: `: heartbeat` (a comment)
 * Clients resume by sending `Last-Event-ID: <sequence>`.
 */
export const ssePreamble = "retry: 1000\n\n"

export const encodeSse = (frame: FeedFrame): string => Match.valueTags(frame, {
  FeedRecord: (record) => `id: ${record.sequence}\nevent: ${record.event}\ndata: ${JSON.stringify(record.data)}\n\n`,
  FeedReady: () => "event: ready\ndata: {}\n\n",
  FeedHeartbeat: () => ": heartbeat\n\n",
})

const fieldsOf = (block: string): ReadonlyMap<string, string> => new Map(block.split("\n").flatMap((line) => {
  const colon = line.indexOf(":")
  return colon <= 0 ? [] : [[line.slice(0, colon), line.slice(colon + 1).trimStart()] as const]
}))

const decodeRecordFields = Schema.decodeUnknownResult(SseRecordFields)

/** A block of comments or of `retry` alone carries no frame; any other block must be a frame `encodeSse` writes. */
const decodeSseBlock = (block: string): Result.Result<ReadonlyArray<FeedFrame>, RenderError> => {
  if (block.startsWith(": heartbeat")) return Result.succeed([FeedHeartbeat.make({})])
  const fields = fieldsOf(block)
  if (fields.get("event") === "ready") return Result.succeed([FeedReady.make({})])
  if (!["id", "event", "data"].some((name) => fields.has(name))) return Result.succeed([])
  return decodeRecordFields(Object.fromEntries(fields)).pipe(
    Result.map((record): ReadonlyArray<FeedFrame> => [{ _tag: "FeedRecord", sequence: record.sequence, event: record.event, data: record.data }]),
    Result.mapError((error) => new RenderError({ code: "invalid", message: `Invalid SSE record: ${error.message}` })),
  )
}

/** The inverse of `encodeSse` over a whole stream, for clients and tests; a malformed record fails with `invalid`. */
export const decodeSse = (text: string): Result.Result<ReadonlyArray<FeedFrame>, RenderError> =>
  Result.all(text.split("\n\n").filter((block) => block.length > 0).map(decodeSseBlock)).pipe(Result.map((blocks) => blocks.flat()))

export const encodeSocketFrame = (frame: FeedFrame): string => JSON.stringify(Match.valueTags(frame, {
  FeedRecord: (record): SocketFrame => ({ type: "record", sequence: record.sequence, event: record.event, data: record.data }),
  FeedReady: (): SocketFrame => ({ type: "ready" }),
  FeedHeartbeat: (): SocketFrame => ({ type: "heartbeat" }),
}))

/** @public */
export const decodeSocketFrame = (text: string): Option.Option<FeedFrame> =>
  Result.getSuccess(Schema.decodeUnknownResult(Schema.fromJsonString(SocketFrame))(text)).pipe(Option.map((frame): FeedFrame =>
    Match.value(frame).pipe(Match.discriminatorsExhaustive("type")({
      record: (record): FeedFrame => FeedRecord.make({ sequence: record.sequence, event: record.event, data: record.data }),
      ready: (): FeedFrame => FeedReady.make({}),
      heartbeat: (): FeedFrame => FeedHeartbeat.make({}),
    }))))

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
