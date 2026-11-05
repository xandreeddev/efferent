import { Clock, Deferred, Duration, Effect, Layer, Option, Queue, Scope, Stream } from "effect"
import { FeedHeartbeat, FeedReady, FeedRecord } from "./domain/feed-frame.entity.js"
import type { FeedFrame, FeedOptions, FeedPayload, FeedScope, JournalRecord } from "./domain/feed-frame.entity.js"
import { isOfKinds, nextPollMs, startsFromSnapshot, transientOf } from "./domain/feed-frame.entity.functions.js"
import { RenderError } from "./domain/render-surface.entity.js"
import { JournalTail, RenderFeed } from "./ports/render.port.js"
import type { FeedFramesOptions, FeedProjection, FeedSnapshot } from "./ports/render.port.js"

interface Cursor {
  readonly after: number
  readonly ready: boolean
  readonly delayMs: number
  /** When the last frame went out; heartbeats fill silence. */
  readonly quietSince: number
  readonly startedAt: number
}

/** The frames one poll emits, and the next cursor (none: the feed ends). */
type Step = readonly [ReadonlyArray<FeedFrame>, Option.Option<Cursor>]

/** One read of the tail after `after`, asking for `kinds` when the feed has them (a tail that has no filter gets its two-argument call). */
const readAfter = (tail: typeof JournalTail.Service, feed: FeedScope, after: number, kinds: Option.Option<ReadonlyArray<string>>) =>
  Option.match(kinds, { onNone: () => tail.read(feed, after), onSome: (only) => tail.read(feed, after, only) })

/** The records `1..head` of `kinds`, read page by page in sequence order. */
const prefixOf = (tail: typeof JournalTail.Service, feed: FeedScope, head: number, kinds: Option.Option<ReadonlyArray<string>>): Effect.Effect<ReadonlyArray<JournalRecord>, RenderError> =>
  Stream.runCollect(Stream.paginate(0, (after: number) => after >= head
    ? Effect.succeed([[], Option.none<number>()] as const)
    : readAfter(tail, feed, after, kinds).pipe(Effect.map((records) => {
      const fresh = records.filter((record) => record.sequence > after)
      const last = fresh.reduce((reached, record) => Math.max(reached, record.sequence), after)
      const kept = fresh.filter((record) => record.sequence <= head && isOfKinds(Option.getOrElse(kinds, () => []))(record))
      return [kept, fresh.length === 0 ? Option.none<number>() : Option.some(last)] as const
    })))).pipe(Effect.map((chunk) => Array.from(chunk)))

const isSequence = (head: number): boolean => Number.isSafeInteger(head) && head >= 0

/** The snapshot as a record at its head: the fold of the records up to it. A head that is no sequence fails with `invalid`, whatever the client's cursor. */
const snapshotFrame = <R>(tail: typeof JournalTail.Service, feed: FeedScope, kinds: Option.Option<ReadonlyArray<string>>, snapshot: FeedSnapshot<R>): Effect.Effect<FeedFrame, RenderError, R> =>
  isSequence(snapshot.head)
    ? prefixOf(tail, feed, snapshot.head, kinds).pipe(
      Effect.flatMap(snapshot.fold),
      Effect.map((payload) => FeedRecord.make({ sequence: snapshot.head, event: payload.event, data: payload.data })))
    : Effect.fail(new RenderError({ code: "invalid", message: `Invalid snapshot head ${snapshot.head}: not a journal sequence` }))

/**
 * The wait between polls. With a `changes` stream, a signal cuts the wait
 * short; signals that arrive during a read are kept (one is enough), so the
 * next wait ends at once and nothing written meanwhile is missed.
 */
const waitOf = (tail: typeof JournalTail.Service, feed: FeedScope): Effect.Effect<(delayMs: number) => Effect.Effect<void>, never, Scope.Scope> =>
  Option.match(Option.fromNullishOr(tail.changes), {
    onNone: () => Effect.succeed((delayMs: number) => Effect.sleep(Duration.millis(delayMs))),
    onSome: (changes) => Effect.gen(function* () {
      const wake = yield* Queue.sliding<void>(1)
      yield* changes(feed).pipe(
        Stream.runForEach(() => Queue.offer(wake, undefined)),
        Effect.ignore({ log: "Warn", message: "the render feed's change signal failed; the feed polls without it" }),
        Effect.forkScoped,
      )
      return (delayMs: number) => Effect.race(Effect.sleep(Duration.millis(delayMs)), Queue.take(wake))
    }),
  })

/**
 * The journal side of a feed: records after the cursor (of `kinds`, though the
 * cursor passes every record the tail returns), one ready frame, heartbeats
 * while idle, until `maxDurationMs`.
 */
const journalFrames = <R>(tail: typeof JournalTail.Service, options: FeedOptions, feed: FeedScope, after: number, kinds: Option.Option<ReadonlyArray<string>>, project: FeedProjection<R>): Stream.Stream<FeedFrame, RenderError, R> =>
  Stream.unwrap(Effect.all([Clock.currentTimeMillis, waitOf(tail, feed)], { concurrency: 1 }).pipe(Effect.map(([now, wait]) =>
    Stream.paginate({ after, ready: false, delayMs: 0, quietSince: now, startedAt: now } satisfies Cursor, (cursor): Effect.Effect<Step, RenderError, R> => Effect.gen(function* () {
      yield* wait(cursor.delayMs)
      const at = yield* Clock.currentTimeMillis
      if (at - cursor.startedAt >= options.maxDurationMs) return [[], Option.none()] as const
      const fresh = (yield* readAfter(tail, feed, cursor.after, kinds)).filter((record) => record.sequence > cursor.after)
      if (fresh.length > 0) {
        const projected = yield* Effect.forEach(fresh.filter(isOfKinds(Option.getOrElse(kinds, () => []))), (record) => project(record).pipe(Effect.map(Option.map((payload) =>
          FeedRecord.make({ sequence: record.sequence, event: payload.event, data: payload.data })))), { concurrency: 1 })
        const frames = projected.flatMap(Option.toArray)
        const next: Cursor = {
          ...cursor,
          after: fresh.reduce((last, record) => Math.max(last, record.sequence), cursor.after),
          delayMs: nextPollMs(cursor.delayMs, options, true),
          quietSince: frames.length > 0 ? at : cursor.quietSince,
        }
        return [frames, Option.some(next)] as const
      }
      const heartbeat = cursor.ready && at - cursor.quietSince >= options.heartbeatMs
      const frames: ReadonlyArray<FeedFrame> = [
        ...(cursor.ready ? [] : [FeedReady.make({})]),
        ...(heartbeat ? [FeedHeartbeat.make({})] : []),
      ]
      const next: Cursor = {
        ...cursor,
        ready: true,
        delayMs: nextPollMs(cursor.delayMs, options, false),
        quietSince: frames.length > 0 ? at : cursor.quietSince,
      }
      return [frames, Option.some(next)] as const
    })),
  )))

/**
 * Live frames beside the journal's: each payload goes out as a transient
 * frame once the journal side has sent its ready frame (the backlog comes
 * first; the live stream's own buffering decides what waits meanwhile), and
 * the merged stream ends when the journal side does. A live stream that
 * ends only stops live frames; one that fails, or a payload named `ready`,
 * fails the feed.
 */
const withLive = <R>(journal: Stream.Stream<FeedFrame, RenderError, R>, live: Stream.Stream<FeedPayload, RenderError>): Stream.Stream<FeedFrame, RenderError, R> =>
  Stream.unwrap(Deferred.make<void>().pipe(Effect.map((caughtUp) => Stream.merge(
    // Release the live side only once the ready frame is out, so no transient frame overtakes it.
    journal.pipe(Stream.flatMap((frame) => Stream.succeed(frame).pipe(Stream.concat(
      frame._tag === "FeedReady" ? Stream.fromEffectDrain(Deferred.succeed(caughtUp, undefined)) : Stream.empty)))),
    live.pipe(Stream.mapEffect((payload) => Deferred.await(caughtUp).pipe(Effect.andThen(Effect.fromResult(transientOf(payload)))))),
    { haltStrategy: "left" },
  ))))

/**
 * A journal tail as a stream of frames: records after the cursor (projected),
 * one ready frame after the first empty poll, heartbeats while idle, idle
 * polling backs off (a `changes` signal polls at once); the stream ends after
 * `maxDurationMs`. With `kinds`, only those kinds are read and projected;
 * with a `snapshot`, a client at cursor 0 or past its head first gets the
 * fold of the records up to the head, as a record with the head's sequence,
 * and the tail follows from there. A `live` stream's payloads join as
 * transient frames after the ready frame; they never move the cursor.
 *
 * @public
 */
export const makeRenderFeed = (tail: typeof JournalTail.Service, options: FeedOptions) => RenderFeed.of({
  frames: <R, RF>(feed: FeedScope, after: number, project: FeedProjection<R>, framesOptions: FeedFramesOptions<RF> = {}): Stream.Stream<FeedFrame, RenderError, R | RF> => {
    const kinds = Option.filter(Option.fromNullishOr(framesOptions.kinds), (only) => only.length > 0)
    const journal = Option.match(Option.filter(Option.fromNullishOr(framesOptions.snapshot), (snapshot) => !isSequence(snapshot.head) || startsFromSnapshot(after, snapshot.head)), {
      onNone: () => journalFrames(tail, options, feed, after, kinds, project),
      onSome: (snapshot) => Stream.fromEffect(snapshotFrame(tail, feed, kinds, snapshot)).pipe(
        Stream.concat(journalFrames(tail, options, feed, snapshot.head, kinds, project))),
    })
    return Option.match(Option.fromNullishOr(framesOptions.live), { onNone: () => journal, onSome: (live) => withLive(journal, live) })
  },
})

export const RenderFeedLive = (options: FeedOptions) =>
  Layer.effect(RenderFeed, JournalTail.pipe(Effect.map((tail) => makeRenderFeed(tail, options))))
