import { Clock, Duration, Effect, Layer, Option, Queue, Scope, Stream } from "effect"
import { FeedHeartbeat, FeedReady, FeedRecord } from "./domain/feed-frame.entity.js"
import type { FeedFrame, FeedOptions, FeedScope } from "./domain/feed-frame.entity.js"
import { nextPollMs } from "./domain/feed-frame.entity.functions.js"
import type { RenderError } from "./domain/render-surface.entity.js"
import { JournalTail, RenderFeed } from "./ports/render.port.js"

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
      yield* changes(feed).pipe(Stream.runForEach(() => Queue.offer(wake, undefined)), Effect.ignore, Effect.forkScoped)
      return (delayMs: number) => Effect.race(Effect.sleep(Duration.millis(delayMs)), Queue.take(wake))
    }),
  })

/**
 * A journal tail as a stream of frames: records after the cursor (projected),
 * one ready frame after the first empty poll, heartbeats while idle, idle
 * polling backs off (a `changes` signal polls at once); the stream ends after
 * `maxDurationMs`.
 */
export const makeRenderFeed = (tail: typeof JournalTail.Service, options: FeedOptions) => RenderFeed.of({
  frames: (feed, after, project) => Stream.unwrap(Effect.all([Clock.currentTimeMillis, waitOf(tail, feed)]).pipe(Effect.map(([now, wait]) =>
    Stream.paginate({ after, ready: false, delayMs: 0, quietSince: now, startedAt: now } satisfies Cursor, (cursor): Effect.Effect<Step, RenderError> => Effect.gen(function* () {
      yield* wait(cursor.delayMs)
      const at = yield* Clock.currentTimeMillis
      if (at - cursor.startedAt >= options.maxDurationMs) return [[], Option.none()] as const
      const fresh = (yield* tail.read(feed, cursor.after)).filter((record) => record.sequence > cursor.after)
      if (fresh.length > 0) {
        const projected = yield* Effect.forEach(fresh, (record) => project(record).pipe(Effect.map(Option.map((payload) =>
          FeedRecord.make({ sequence: record.sequence, event: payload.event, data: payload.data })))))
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
  ))),
})

export const RenderFeedLive = (options: FeedOptions) =>
  Layer.effect(RenderFeed, JournalTail.pipe(Effect.map((tail) => makeRenderFeed(tail, options))))
