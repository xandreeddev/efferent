import { Either, Match, Option, Schema } from "effect"
import { FeedHeartbeat, FeedReady, FeedRecord, SocketFrame, SocketResume } from "./feed-frame.entity.js"
import type { FeedFrame, FeedOptions } from "./feed-frame.entity.js"

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

const parseObject = (text: string): Option.Option<Record<string, unknown>> =>
  Either.getRight(Schema.decodeUnknownEither(Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })))(text))

const decodeSseBlock = (block: string): ReadonlyArray<FeedFrame> => {
  if (block.startsWith(": heartbeat")) return [FeedHeartbeat.make({})]
  const fields = fieldsOf(block)
  const event = fields.get("event")
  if (event === "ready") return [FeedReady.make({})]
  const id = Number(fields.get("id"))
  const data = parseObject(fields.get("data") ?? "")
  return event === undefined || !Number.isInteger(id) || Option.isNone(data)
    ? []
    : [FeedRecord.make({ sequence: id, event, data: data.value })]
}

/** The inverse of `encodeSse` over a whole stream, for clients and tests. */
export const decodeSse = (text: string): ReadonlyArray<FeedFrame> =>
  text.split("\n\n").filter((block) => block.length > 0).flatMap(decodeSseBlock)

export const encodeSocketFrame = (frame: FeedFrame): string => JSON.stringify(Match.valueTags(frame, {
  FeedRecord: (record): SocketFrame => ({ type: "record", sequence: record.sequence, event: record.event, data: record.data }),
  FeedReady: (): SocketFrame => ({ type: "ready" }),
  FeedHeartbeat: (): SocketFrame => ({ type: "heartbeat" }),
}))

export const decodeSocketFrame = (text: string): Option.Option<FeedFrame> =>
  Either.getRight(Schema.decodeUnknownEither(Schema.parseJson(SocketFrame))(text)).pipe(Option.map((frame): FeedFrame =>
    Match.value(frame).pipe(
      Match.when({ type: "record" }, (record) => FeedRecord.make({ sequence: record.sequence, event: record.event, data: record.data })),
      Match.when({ type: "ready" }, () => FeedReady.make({})),
      Match.orElse(() => FeedHeartbeat.make({})),
    )))

/** The cursor a WebSocket client asks to resume after (`{"after": n}`). */
export const socketResumeOf = (text: string): Option.Option<number> =>
  Either.getRight(Schema.decodeUnknownEither(Schema.parseJson(SocketResume))(text)).pipe(Option.map((resume) => resume.after))

/** Back off while idle; poll promptly again once records arrive. */
export const nextPollMs = (current: number, options: FeedOptions, received: boolean): number =>
  received ? options.pollMs : Math.min(options.maxPollMs, Math.max(options.pollMs, current * 2))
