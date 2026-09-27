import { Effect, Fiber, Option, Ref, Stream } from "effect"
import { canonicalJson } from "@xandreed/core"
import { ConformanceFailure } from "./domain/conformance.entity.js"
import { FeedHeartbeat, FeedReady, FeedRecord } from "./domain/feed-frame.entity.js"
import type { FeedFrame, FeedOptions, JournalRecord } from "./domain/feed-frame.entity.js"
import { decodeSocketFrame, decodeSse } from "./domain/feed-frame.entity.functions.js"
import type { RenderError } from "./domain/render-surface.entity.js"
import type { FeedProjection, JournalTail, RenderFeed, RenderTransport, SocketPeer, SsePeer } from "./ports/render.port.js"
import type { ConformanceCheck } from "./render-surface.conformance.js"

const holds = (check: string) => (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new ConformanceFailure({ check, message }))

const sample: ReadonlyArray<FeedFrame> = [
  FeedRecord.make({ sequence: 1, event: "surface.planned", data: { versionId: "m:v1", nested: { list: [1, 2], text: "line\nbreak" } } }),
  FeedReady.make({}),
  FeedHeartbeat.make({}),
  FeedRecord.make({ sequence: 2, event: "message.updated", data: { text: "é ✓" } }),
]

/** The two shipped wires must carry the same frames. */
export const renderTransportConformance = (transports: {
  readonly sse: RenderTransport<SsePeer>
  readonly socket: RenderTransport<SocketPeer>
}): ReadonlyArray<ConformanceCheck> => [{
  name: "SSE and WebSocket carry identical frames",
  run: Effect.gen(function* () {
    const expect = holds("SSE and WebSocket carry identical frames")
    const written = yield* Ref.make<ReadonlyArray<string>>([])
    const sent = yield* Ref.make<ReadonlyArray<string>>([])
    yield* transports.sse.serve(Stream.fromIterable(sample), { write: (chunk) => Ref.update(written, (all) => [...all, chunk]), closed: Effect.never })
    yield* transports.socket.serve(Stream.fromIterable(sample), { send: (text) => Ref.update(sent, (all) => [...all, text]), closed: Effect.never })
    const viaSse = decodeSse((yield* Ref.get(written)).join(""))
    const viaSocket = (yield* Ref.get(sent)).flatMap((text) => Option.toArray(decodeSocketFrame(text)))
    yield* expect(canonicalJson(viaSse) === canonicalJson(sample), `SSE frames differ: ${canonicalJson(viaSse)}`)
    yield* expect(canonicalJson(viaSocket) === canonicalJson(sample), `WebSocket frames differ: ${canonicalJson(viaSocket)}`)
  }),
}]

/** An appendable journal for feed checks. */
export const makeMemoryJournal = (initial: ReadonlyArray<JournalRecord>) => Effect.gen(function* () {
  const records = yield* Ref.make(initial)
  const tail: typeof JournalTail.Service = {
    read: (_feed, after) => Ref.get(records).pipe(Effect.map((all) => all.filter((record) => record.sequence > after))),
  }
  return { tail, append: (record: JournalRecord) => Ref.update(records, (all) => [...all, record]) }
})

const project: FeedProjection = (record) => Effect.succeed(record.kind === "hidden" ? Option.none() : Option.some({ event: record.kind, data: record.data }))
const feedScope = { threadId: "thread", principalId: "guest" }
const record = (sequence: number, kind = "message.updated"): JournalRecord => ({ sequence, kind, data: { sequence } })
const collect = (stream: Stream.Stream<FeedFrame, RenderError>) => Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)))
const sequences = (frames: ReadonlyArray<FeedFrame>) => frames.flatMap((frame) => frame._tag === "FeedRecord" ? [frame.sequence] : [])

/** The contract of a RenderFeed built over a JournalTail with short intervals. */
export const renderFeedConformance = (makeFeed: (tail: typeof JournalTail.Service, options: FeedOptions) => typeof RenderFeed.Service): ReadonlyArray<ConformanceCheck> => {
  const options: FeedOptions = { pollMs: 5, maxPollMs: 10, heartbeatMs: 30, maxDurationMs: 150 }
  return [
    {
      name: "the feed resumes after the cursor and sends one ready frame",
      run: Effect.gen(function* () {
        const expect = holds("the feed resumes after the cursor and sends one ready frame")
        const journal = yield* makeMemoryJournal([record(1), record(2), record(3)])
        const frames = yield* collect(makeFeed(journal.tail, options).frames(feedScope, 1, project))
        yield* expect(canonicalJson(sequences(frames)) === canonicalJson([2, 3]), `records after cursor 1, got ${canonicalJson(sequences(frames))}`)
        yield* expect(frames.filter((frame) => frame._tag === "FeedReady").length === 1, "exactly one ready frame")
        yield* expect(frames.findIndex((frame) => frame._tag === "FeedReady") > frames.findIndex((frame) => frame._tag === "FeedRecord"), "ready follows the backlog")
      }),
    },
    {
      name: "an idle feed sends heartbeats and later records in order",
      run: Effect.gen(function* () {
        const expect = holds("an idle feed sends heartbeats and later records in order")
        const journal = yield* makeMemoryJournal([record(1)])
        const running = yield* Effect.fork(collect(makeFeed(journal.tail, options).frames(feedScope, 0, project)))
        yield* Effect.sleep("60 millis")
        yield* journal.append(record(2))
        yield* journal.append(record(3, "hidden"))
        yield* journal.append(record(4))
        const frames = yield* Fiber.join(running)
        yield* expect(canonicalJson(sequences(frames)) === canonicalJson([1, 2, 4]), `in order, hidden records skipped, got ${canonicalJson(sequences(frames))}`)
        yield* expect(frames.some((frame) => frame._tag === "FeedHeartbeat"), "a heartbeat while idle")
      }),
    },
  ]
}
