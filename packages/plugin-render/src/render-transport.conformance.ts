import { Context, Effect, Fiber, Logger, Option, PubSub, Ref, Stream } from "effect"
import type { Equivalence } from "effect"
import { canonicalJson } from "@xandreed/core"
import { ConformanceFailure } from "@xandreed/core/conformance"
import { FeedHeartbeat, FeedReady, FeedRecord, FeedTransient } from "./domain/feed-frame.entity.js"
import type { FeedFrame, FeedOptions, FeedPayload, JournalRecord } from "./domain/feed-frame.entity.js"
import { decodeSocketFrame, decodeSse, isOfKinds } from "./domain/feed-frame.entity.functions.js"
import { PrincipalId, ThreadId } from "./domain/render-output.entity.js"
import { RenderError } from "./domain/render-surface.entity.js"
import type { FeedProjection, JournalTail, RenderFeed, RenderTransport, SnapshotFold, SocketPeer, SsePeer } from "./ports/render.port.js"
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
 * as `Sessions.changes` does). Both read only the `kinds` asked for.
 *
 * @public
 */
export const makeMemoryJournal = Effect.fnUntraced(function* (initial: ReadonlyArray<JournalRecord>) {
  const records = yield* Ref.make(initial)
  const appended = yield* PubSub.sliding<void>(1)
  const tail: typeof JournalTail.Service = {
    read: (_feed, after, kinds = []) => Ref.get(records).pipe(Effect.map((all) => all.filter((record) => record.sequence > after && isOfKinds(kinds)(record)))),
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
const viewingFold: SnapshotFold = () => Viewer.useSync((viewer) => ({ event: "snapshot", data: { viewer } }))
const feedScope = { threadId: ThreadId.make("thread"), principalId: PrincipalId.make("guest") }
const record = (sequence: number, kind = "message.updated"): JournalRecord => ({ sequence, kind, data: { sequence } })
const collect = (stream: Stream.Stream<FeedFrame, RenderError>) => Stream.runCollect(stream).pipe(Effect.map((chunk) => Array.from(chunk)))
const sequences = (frames: ReadonlyArray<FeedFrame>) => frames.flatMap((frame) => frame._tag === "FeedRecord" ? [frame.sequence] : [])
const transients = (frames: ReadonlyArray<FeedFrame>) => frames.flatMap((frame) => frame._tag === "FeedTransient" ? [frame.event] : [])
const livePayload = (event: string): FeedPayload => ({ event, data: { event } })
/** The snapshot the feed checks fold to: the sequences and kinds it was given, so a check sees exactly what was folded. */
const foldOf: SnapshotFold = (folded) => Effect.succeed({ event: "snapshot", data: { sequences: folded.map((one) => one.sequence), kinds: folded.map((one) => one.kind) } })
const recordFrames = (frames: ReadonlyArray<FeedFrame>) => frames.flatMap((frame) => frame._tag === "FeedRecord" ? [frame] : [])
/** A tail over `journal` that remembers the kinds each read asked for, and returns every kind (a tail with no filter). */
const unfiltered = (journal: typeof JournalTail.Service, asked: Ref.Ref<ReadonlyArray<ReadonlyArray<string>>>): typeof JournalTail.Service => ({
  read: (feed, after, kinds) => Ref.update(asked, (all) => [...all, kinds ?? []]).pipe(Effect.andThen(journal.read(feed, after))),
})

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
        const frames = yield* collect(makeFeed(journal.tail, options).frames(feedScope, 0, project, { live })).pipe(Effect.timeout("2 seconds"), Effect.option)
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
        const running = yield* Effect.forkChild(collect(makeFeed(journal.tail, options).frames(feedScope, 0, project, { live: Stream.make(livePayload("live.only")) })))
        yield* Effect.sleep("60 millis")
        yield* journal.append(record(2))
        const frames = yield* Fiber.join(running)
        yield* expect(canonicalJson(sequences(frames)) === canonicalJson([1, 2]), `the record appended after the live stream ended, got ${canonicalJson(sequences(frames))}`)
        yield* expect(canonicalJson(transients(frames)) === canonicalJson(["live.only"]), `the live payload, got ${canonicalJson(transients(frames))}`)
      }),
    },
    {
      name: "a client at cursor 0 or past the head starts from the snapshot, then follows the tail",
      run: Effect.gen(function* () {
        const expect = holds("a client at cursor 0 or past the head starts from the snapshot, then follows the tail")
        const journal = yield* makeMemoryJournal([record(1), record(2), record(3)])
        const snapshot = { head: 2, fold: foldOf }
        const running = yield* Effect.forkChild(collect(makeFeed(journal.tail, options).frames(feedScope, 0, project, { snapshot })))
        yield* Effect.sleep("60 millis")
        yield* journal.append(record(4))
        const cold = yield* Fiber.join(running)
        const first = cold[0]
        yield* expect(canonicalJson(first) === canonicalJson(FeedRecord.make({ sequence: 2, event: "snapshot", data: { sequences: [1, 2], kinds: ["message.updated", "message.updated"] } })),
          `the first frame is the fold of records 1..2 at sequence 2, got ${canonicalJson(first)}`)
        yield* expect(canonicalJson(sequences(cold)) === canonicalJson([2, 3, 4]), `the snapshot, then the records after the head, got ${canonicalJson(sequences(cold))}`)
        yield* expect(cold.filter((frame) => frame._tag === "FeedReady").length === 1 && cold.findIndex((frame) => frame._tag === "FeedReady") > 1, "one ready frame, after the snapshot and the backlog")
        const stale = yield* collect(makeFeed(journal.tail, options).frames(feedScope, 9, project, { snapshot }))
        yield* expect(canonicalJson(sequences(stale)) === canonicalJson([2, 3, 4]) && recordFrames(stale)[0]?.event === "snapshot",
          `a cursor past the head starts from the snapshot too, got ${canonicalJson(sequences(stale))}`)
      }),
    },
    {
      name: "a client at a cursor up to the head resumes without the snapshot",
      run: Effect.gen(function* () {
        const expect = holds("a client at a cursor up to the head resumes without the snapshot")
        const journal = yield* makeMemoryJournal([record(1), record(2), record(3)])
        const snapshot = { head: 2, fold: foldOf }
        const behind = yield* collect(makeFeed(journal.tail, options).frames(feedScope, 1, project, { snapshot }))
        const atHead = yield* collect(makeFeed(journal.tail, options).frames(feedScope, 2, project, { snapshot }))
        yield* expect(canonicalJson(recordFrames(behind).map((frame) => frame.event)) === canonicalJson(["message.updated", "message.updated"]) && canonicalJson(sequences(behind)) === canonicalJson([2, 3]),
          `cursor 1 replays 2 and 3, got ${canonicalJson(recordFrames(behind))}`)
        yield* expect(canonicalJson(sequences(atHead)) === canonicalJson([3]), `the snapshot's own sequence resumes after it, got ${canonicalJson(sequences(atHead))}`)
      }),
    },
    {
      name: "a kinds filter reads, folds and sends only those kinds",
      run: Effect.gen(function* () {
        const expect = holds("a kinds filter reads, folds and sends only those kinds")
        const journal = yield* makeMemoryJournal([record(1), record(2, "tool.input"), record(3), record(4, "tool.input"), record(5)])
        const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
        const tail: typeof JournalTail.Service = { read: (feed, after, kinds) => Ref.update(asked, (all) => [...all, kinds ?? []]).pipe(Effect.andThen(journal.tail.read(feed, after, kinds))) }
        const frames = yield* collect(makeFeed(tail, options).frames(feedScope, 0, project, { kinds: ["message.updated"], snapshot: { head: 3, fold: foldOf } }))
        const reads = yield* Ref.get(asked)
        yield* expect(canonicalJson(recordFrames(frames)[0]?.data) === canonicalJson({ sequences: [1, 3], kinds: ["message.updated", "message.updated"] }),
          `the snapshot folds only those kinds, got ${canonicalJson(recordFrames(frames)[0]?.data)}`)
        yield* expect(canonicalJson(sequences(frames)) === canonicalJson([3, 5]), `the tail sends only those kinds, got ${canonicalJson(sequences(frames))}`)
        yield* expect(reads.length > 0 && reads.every((kinds) => canonicalJson(kinds) === canonicalJson(["message.updated"])), `every read asks the tail for those kinds, asked ${canonicalJson(reads)}`)
      }),
    },
    {
      name: "records of other kinds still move the cursor",
      run: Effect.gen(function* () {
        const expect = holds("records of other kinds still move the cursor")
        // A tail with no filter returns every kind: the feed drops the others, and passes them, so the journal still reads as caught up.
        const journal = yield* makeMemoryJournal([record(1), record(2, "tool.input"), record(3), record(4, "tool.input")])
        const asked = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
        const running = yield* Effect.forkChild(collect(makeFeed(unfiltered(journal.tail, asked), options).frames(feedScope, 0, project, { kinds: ["message.updated"], snapshot: { head: 2, fold: foldOf } })))
        yield* Effect.sleep("60 millis")
        yield* journal.append(record(5, "tool.input"))
        yield* journal.append(record(6))
        const frames = yield* Fiber.join(running)
        yield* expect(canonicalJson(recordFrames(frames)[0]?.data) === canonicalJson({ sequences: [1], kinds: ["message.updated"] }),
          `the snapshot folds only those kinds from a tail that returns every kind, got ${canonicalJson(recordFrames(frames)[0]?.data)}`)
        yield* expect(canonicalJson(sequences(frames)) === canonicalJson([2, 3, 6]), `each record of those kinds once, in order, got ${canonicalJson(sequences(frames))}`)
        const ready = frames.findIndex((frame) => frame._tag === "FeedReady")
        yield* expect(ready >= 0 && sequences(frames.slice(0, ready)).length === 2, "the ready frame follows the backlog: the records of other kinds after the last one sent did not hold it back")
      }),
    },
    {
      name: "the projection and the fold run with the services provided to the stream",
      run: Effect.gen(function* () {
        const expect = holds("the projection and the fold run with the services provided to the stream")
        const journal = yield* makeMemoryJournal([record(1), record(2)])
        const frames = yield* collect(makeFeed(journal.tail, options).frames(feedScope, 0, viewing).pipe(Stream.provideService(Viewer, "guest")))
        const viewers = frames.flatMap((frame) => frame._tag === "FeedRecord" ? [frame.data["viewer"]] : [])
        yield* expect(canonicalJson(viewers) === canonicalJson(["guest", "guest"]), `each record projected with the stream's services, got ${canonicalJson(viewers)}`)
        const cold = yield* collect(makeFeed(journal.tail, options).frames(feedScope, 0, viewing, { snapshot: { head: 1, fold: viewingFold } }).pipe(Stream.provideService(Viewer, "guest")))
        const coldViewers = recordFrames(cold).map((frame) => [frame.event, frame.data["viewer"]])
        yield* expect(canonicalJson(coldViewers) === canonicalJson([["snapshot", "guest"], ["message.updated", "guest"]]), `the snapshot folded with the stream's services, got ${canonicalJson(coldViewers)}`)
      }),
    },
  ]
}

/**
 * What `foldEqualsReplay` checks: a sample journal, the feed's `kinds`,
 * projection and fold, and how a client applies a record's payload to its
 * state (the snapshot's included, which replaces the state it had).
 *
 * @public
 */
export interface FoldReplaySubject<S, R = never> {
  /** A sample journal, in sequence order: the fold is cut at 0 and at every one of its sequences. */
  readonly records: ReadonlyArray<JournalRecord>
  readonly kinds?: ReadonlyArray<string>
  readonly project: FeedProjection<R>
  readonly fold: SnapshotFold<R>
  /** A client's state before its first frame. */
  readonly initial: S
  /** A client receiving one record frame's payload. */
  readonly apply: (state: S, payload: FeedPayload) => S
  /** When two states are the same; equal canonical JSON by default. */
  readonly equivalence?: Equivalence.Equivalence<S>
}

/**
 * A snapshot fold against its projection, over every cut of a sample journal
 * (0 and each record's sequence): a client that starts from the snapshot at
 * the cut holds the state of one that applied every projected record up to
 * it, so does a client whose state is past the cut (it reconnects with a
 * cursor beyond the head: the snapshot replaces its state), and both end in
 * the replay's state once the records after the cut are applied. The fold and
 * the projection see only `kinds`, as the feed gives them. Fails with
 * `ConformanceFailure` naming the first cut that differs, or one that fails
 * to fold or project.
 *
 * @public
 */
export const foldEqualsReplay = <S, R = never>(subject: FoldReplaySubject<S, R>): Effect.Effect<void, ConformanceFailure, R> => {
  const name = "the snapshot fold equals the replay"
  const expect = holds(name)
  const same = subject.equivalence ?? ((a: S, b: S) => canonicalJson(a) === canonicalJson(b))
  const kept = subject.records.filter(isOfKinds(subject.kinds ?? []))
  const replay = (state: S, payloads: ReadonlyArray<FeedPayload>) => payloads.reduce(subject.apply, state)
  return Effect.gen(function* () {
    const projected = yield* Effect.forEach(kept, (one) => subject.project(one).pipe(Effect.map((payload) => ({ sequence: one.sequence, payload }))), { concurrency: 1 })
    const upTo = (cut: number) => projected.flatMap((one) => one.sequence <= cut ? Option.toArray(one.payload) : [])
    const after = (cut: number) => projected.flatMap((one) => one.sequence > cut ? Option.toArray(one.payload) : [])
    const whole = replay(subject.initial, upTo(Number.POSITIVE_INFINITY))
    yield* Effect.forEach([0, ...subject.records.map((one) => one.sequence)], (cut) => Effect.gen(function* () {
      const snapshot = yield* subject.fold(kept.filter((one) => one.sequence <= cut))
      const replayed = replay(subject.initial, upTo(cut))
      const cold = subject.apply(subject.initial, snapshot)
      const stale = subject.apply(whole, snapshot)
      yield* expect(same(cold, replayed), `at head ${cut}, the snapshot gives ${canonicalJson(cold)}, the replay ${canonicalJson(replayed)}`)
      yield* expect(same(stale, replayed), `at head ${cut}, the snapshot applied to a client past the head gives ${canonicalJson(stale)}, the replay ${canonicalJson(replayed)}`)
      yield* expect(same(replay(cold, after(cut)), whole), `from head ${cut}, the snapshot and the records after it give ${canonicalJson(replay(cold, after(cut)))}, the whole replay ${canonicalJson(whole)}`)
    }), { concurrency: 1, discard: true })
  }).pipe(Effect.catchTag("RenderError", (error) => Effect.fail(new ConformanceFailure({ check: name, message: `the fold or the projection failed: ${error.message}` }))))
}
