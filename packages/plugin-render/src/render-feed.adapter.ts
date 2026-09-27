import { Chunk, Clock, Duration, Effect, Layer, Option, Stream } from "effect"
import { FeedHeartbeat, FeedReady, FeedRecord } from "./domain/feed-frame.entity.js"
import type { FeedFrame, FeedOptions } from "./domain/feed-frame.entity.js"
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

type Step = Option.Option<readonly [Chunk.Chunk<FeedFrame>, Cursor]>

/**
 * A journal tail as a stream of frames: records after the cursor (projected),
 * one ready frame after the first empty poll, heartbeats while idle, idle
 * polling backs off; the stream ends after `maxDurationMs`.
 */
export const makeRenderFeed = (tail: typeof JournalTail.Service, options: FeedOptions) => RenderFeed.of({
  frames: (feed, after, project) => Stream.unwrap(Clock.currentTimeMillis.pipe(Effect.map((now) =>
    Stream.unfoldChunkEffect({ after, ready: false, delayMs: 0, quietSince: now, startedAt: now } satisfies Cursor, (cursor): Effect.Effect<Step, RenderError> => Effect.gen(function* () {
      yield* Effect.sleep(Duration.millis(cursor.delayMs))
      const at = yield* Clock.currentTimeMillis
      if (at - cursor.startedAt >= options.maxDurationMs) return Option.none()
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
        return Option.some([Chunk.fromIterable<FeedFrame>(frames), next] as const)
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
      return Option.some([Chunk.fromIterable(frames), next] as const)
    })),
  ))),
})

export const RenderFeedLive = (options: FeedOptions) =>
  Layer.effect(RenderFeed, JournalTail.pipe(Effect.map((tail) => makeRenderFeed(tail, options))))
