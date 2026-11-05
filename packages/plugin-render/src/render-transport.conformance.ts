import { Context, Effect, Fiber, Logger, Option, PubSub, Ref, Stream } from "effect"
import { canonicalJson } from "@xandreed/core"
import { ConformanceFailure } from "@xandreed/core/conformance"
import { FeedHeartbeat, FeedReady, FeedRecord, FeedTransient } from "./domain/feed-frame.entity.js"
import type { FeedFrame, FeedOptions, FeedPayload, JournalRecord } from "./domain/feed-frame.entity.js"
import { decodeSocketFrame, decodeSse } from "./domain/feed-frame.entity.functions.js"
import { PrincipalId, ThreadId } from "./domain/render-output.entity.js"
import { RenderError } from "./domain/render-surface.entity.js"
import type { FeedProjection, JournalTail, RenderFeed, RenderTransport, SocketPeer, SsePeer } from "./ports/render.port.js"
import type { ConformanceCheck } from "./render-surface.conformance.js"

const holds = (check: string) => (condition: boolean, message: string) =>
  condition ? Effect.void : Effect.fail(new ConformanceFailure({ check, message }))

const sample: ReadonlyArray<FeedFrame> = [
  FeedRecord.make({ sequence: 1, event: "surface.planned", data: { versionId: "m:v1", nested: { list: [1, 2], text: "line\nbreak" } } }),
  FeedReady.make({}),
  FeedTransient.make({ event: "reply.delta", data: { text: "par", nested: { list: [1, 2], text: "line\nbreak" } } }),
  FeedHeartbeat.make({}),
  FeedRecord.make({ sequence: 2, event: "message.updated", data: { text: "é ✓" } }),
  FeedTransient.make({ event: "preview", data: {} }),
]

/** How many times an SSE transport ends a peer whose client leaves when `closed` completes. */
const endsOf = (transport: RenderTransport<SsePeer>, frames: Stream.Stream<FeedFrame, RenderError>, closed: Effect.Effect<void>) => Effect.gen(function* () {
  const ended = yield* Ref.make(0)
  yield* transport.serve(frames, { write: () => Effect.void, closed, end: Ref.update(ended, (count) => count + 1) })
  return yield* Ref.get(ended)
})

/**
 * The two shipped wires must carry the same frames, and SSE must end its peer
 * exactly when the frames end.
 *
 * @public
 */
export const renderTransportConformance = (transports: {
  readonly sse: RenderTransport<SsePeer>
  readonly socket: RenderTransport<SocketPeer>
}): ReadonlyArray<ConformanceCheck> => [{
  name: "SSE and WebSocket carry identical frames",
  run: Effect.gen(function* () {
    const expect = holds("SSE and WebSocket carry identical frames")
    const written = yield* Ref.make<ReadonlyArray<string>>([])
    const sent = yield* Ref.make<ReadonlyArray<string>>([])
    yield* transports.sse.serve(Stream.fromIterable(sample), { write: (chunk) => Ref.update(written, (all) => [...all, chunk]), closed: Effect.never, end: Effect.void })
    yield* transports.socket.serve(Stream.fromIterable(sample), { send: (text) => Ref.update(sent, (all) => [...all, text]), closed: Effect.never })
    const viaSse = yield* Effect.fromResult(decodeSse((yield* Ref.get(written)).join("")))
    const viaSocket = (yield* Ref.get(sent)).flatMap((text) => Option.toArray(decodeSocketFrame(text)))
    yield* expect(canonicalJson(viaSse) === canonicalJson(sample), `SSE frames differ: ${canonicalJson(viaSse)}`)
    yield* expect(canonicalJson(viaSocket) === canonicalJson(sample), `WebSocket frames differ: ${canonicalJson(viaSocket)}`)
  }),
}, {
  name: "ends the peer when the frames end",
  run: Effect.gen(function* () {
    const expect = holds("ends the peer when the frames end")
    const finished = yield* endsOf(transports.sse, Stream.fromIterable(sample), Effect.never)
    // The failure is logged by the transport; the check needs only its count.
    const failed = yield* endsOf(transports.sse, Stream.fail(new RenderError({ code: "storage", message: "the journal is unreachable" })), Effect.never).pipe(
      Effect.provide(Logger.layer([])))
    const left = yield* endsOf(transports.sse, Stream.never, Effect.void)
    yield* expect(finished === 1, `frames that end end the peer once, ended ${finished} times`)
    yield* expect(failed === 1, `a failed feed ends the peer once, ended ${failed} times`)
    yield* expect(left === 0, `a client that left is never ended, ended ${left} times`)
  }),
}]

/**
 * An appendable journal for feed checks: `tail` polls only, `wakingTail` also
 * signals after each append (the signals a feed has not taken merge into one,
 * as `Sessions.changes` does).
 *
 * @public
 */
export const makeMemoryJournal = Effect.fnUntraced(function* (initial: ReadonlyArray<JournalRecord>) {
  const records = yield* Ref.make(initial)
  const appended = yield* PubSub.sliding<void>(1)
  const tail: typeof JournalTail.Service = {
    read: (_feed, after) => Ref.get(records).pipe(Effect.map((all) => all.filter((record) => record.sequence > after))),
  }
  const wakingTail: typeof JournalTail.Service = { ...tail, changes: () => Stream.fromPubSub(appended) }
  return {
    tail,
    wakingTail,
    append: (record: JournalRecord) => Ref.update(records, (all) => [...all, record]).pipe(Effect.andThen(PubSub.publish(appended, undefined)), Effect.asVoid),
  }
})

const project: FeedProjection = (record) => Effect.succeed(record.kind === "hidden" ? Option.none() : Option.some({ event: record.kind, data: record.data }))
/** Who the context check's projection shows records to: read from the stream's context, so a feed that runs the projection without it shows "nobody". */
const Viewer = Context.Reference<string>("@xandreed/plugin-render/FeedConformanceViewer", { defaultValue: () => "nobody" })
const viewing: FeedProjection = (record) => Viewer.useSync((viewer) => Option.some({ event: record.kind, data: { viewer } }))
const feedScope = { threadId: ThreadId.make("thread"), principalId: PrincipalId.make("guest") }
const record = (sequence: number, kind = "message.updated"): JournalRecord => ({ sequence, kind, data: { sequence } })
const collect = (stream: Stream.Stream<FeedFrame, RenderError>) => Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)))
const sequences = (frames: ReadonlyArray<FeedFrame>) => frames.flatMap((frame) => frame._tag === "FeedRecord" ? [frame.sequence] : [])
const transients = (frames: ReadonlyArray<FeedFrame>) => frames.flatMap((frame) => frame._tag === "FeedTransient" ? [frame.event] : [])
const livePayload = (event: string): FeedPayload => ({ event, data: { event } })

/**
 * The contract of a RenderFeed built over a JournalTail with short intervals.
 *
 * @public
 */
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
        const running = yield* Effect.forkChild(collect(makeFeed(journal.tail, options).frames(feedScope, 0, project)))
        yield* Effect.sleep("60 millis")
        yield* journal.append(record(2))
        yield* journal.append(record(3, "hidden"))
        yield* journal.append(record(4))
        const frames = yield* Fiber.join(running)
        yield* expect(canonicalJson(sequences(frames)) === canonicalJson([1, 2, 4]), `in order, hidden records skipped, got ${canonicalJson(sequences(frames))}`)
        yield* expect(frames.some((frame) => frame._tag === "FeedHeartbeat"), "a heartbeat while idle")
      }),
    },
    {
      name: "a change signal polls at once instead of waiting out the interval",
      run: Effect.gen(function* () {
        const expect = holds("a change signal polls at once instead of waiting out the interval")
        const slow: FeedOptions = { pollMs: 5_000, maxPollMs: 5_000, heartbeatMs: 10_000, maxDurationMs: 10_000 }
        const journal = yield* makeMemoryJournal([record(1)])
        const running = yield* Effect.forkChild(collect(makeFeed(journal.wakingTail, slow).frames(feedScope, 0, project).pipe(
          Stream.takeUntil((frame) => frame._tag === "FeedRecord" && frame.sequence === 2))))
        yield* Effect.sleep("50 millis")
        yield* journal.append(record(2))
        const frames = yield* Fiber.join(running).pipe(Effect.timeout("1 second"), Effect.option)
        yield* expect(Option.isSome(frames), "the appended record arrived long before the next poll")
        yield* expect(canonicalJson(sequences(Option.getOrElse(frames, () => []))) === canonicalJson([1, 2]), `records in order, got ${canonicalJson(sequences(Option.getOrElse(frames, () => [])))}`)
      }),
    },
    {
      name: "live frames follow the ready frame and end with the journal side",
      run: Effect.gen(function* () {
        const expect = holds("live frames follow the ready frame and end with the journal side")
        const journal = yield* makeMemoryJournal([record(1), record(2)])
        // Ready at once and never ending: only the journal side may end the feed.
        const live = Stream.fromIterable([livePayload("live.first"), livePayload("live.second")]).pipe(Stream.concat(Stream.never))
        const frames = yield* collect(makeFeed(journal.tail, options).frames(feedScope, 0, project, live)).pipe(Effect.timeout("2 seconds"), Effect.option)
        yield* expect(Option.isSome(frames), "the feed ended after maxDurationMs although the live stream never ends")
        const all = Option.getOrElse(frames, () => [])
        const ready = all.findIndex((frame) => frame._tag === "FeedReady")
        yield* expect(canonicalJson(sequences(all)) === canonicalJson([1, 2]), `the backlog, got ${canonicalJson(sequences(all))}`)
        yield* expect(canonicalJson(transients(all)) === canonicalJson(["live.first", "live.second"]), `every live payload in order, got ${canonicalJson(transients(all))}`)
        yield* expect(canonicalJson(all.find((frame) => frame._tag === "FeedTransient")) === canonicalJson(FeedTransient.make({ event: "live.first", data: { event: "live.first" } })), "a live payload as a transient frame, unchanged")
        yield* expect(ready >= 0 && all.every((frame, index) => frame._tag !== "FeedTransient" || index > ready), "no transient frame before the ready frame")
      }),
    },
    {
      name: "a live stream that ends leaves the journal side following",
      run: Effect.gen(function* () {
        const expect = holds("a live stream that ends leaves the journal side following")
        const journal = yield* makeMemoryJournal([record(1)])
        const running = yield* Effect.forkChild(collect(makeFeed(journal.tail, options).frames(feedScope, 0, project, Stream.make(livePayload("live.only")))))
        yield* Effect.sleep("60 millis")
        yield* journal.append(record(2))
        const frames = yield* Fiber.join(running)
        yield* expect(canonicalJson(sequences(frames)) === canonicalJson([1, 2]), `the record appended after the live stream ended, got ${canonicalJson(sequences(frames))}`)
        yield* expect(canonicalJson(transients(frames)) === canonicalJson(["live.only"]), `the live payload, got ${canonicalJson(transients(frames))}`)
      }),
    },
    {
      name: "the projection runs with the services provided to the stream",
      run: Effect.gen(function* () {
        const expect = holds("the projection runs with the services provided to the stream")
        const journal = yield* makeMemoryJournal([record(1), record(2)])
        const frames = yield* collect(makeFeed(journal.tail, options).frames(feedScope, 0, viewing).pipe(Stream.provideService(Viewer, "guest")))
        const viewers = frames.flatMap((frame) => frame._tag === "FeedRecord" ? [frame.data["viewer"]] : [])
        yield* expect(canonicalJson(viewers) === canonicalJson(["guest", "guest"]), `each record projected with the stream's services, got ${canonicalJson(viewers)}`)
      }),
    },
  ]
}
