import { describe, expect, test } from "bun:test"
import { Effect, Option, Stream } from "effect"
import { ConversationId, SessionChannel, SessionChannelError } from "@xandreed/core"
import type { SessionAddress, SessionChannelPayload } from "@xandreed/core"
import { PrincipalId, ThreadId } from "./domain/render-output.entity.js"
import { makeRenderFeed } from "./render-feed.adapter.js"
import { sessionLive } from "./render-live.sessions.adapter.js"
import { makeMemoryJournal } from "./render-transport.conformance.js"

const id = ConversationId.make("00000000-0000-4000-8000-00000000fee1")
const feedOf = (threadId: string = id) => ({ threadId: ThreadId.make(threadId), principalId: PrincipalId.make("owner-1") })
const preview: SessionChannelPayload = { event: "app.preview", data: { html: "<p>draft</p>" } }

/** A channel whose followers receive `payloads` (or fail), recording whom it was asked to follow. */
const channelOf = (followed: Array<SessionAddress>, payloads: ReadonlyArray<SessionChannelPayload>, failing = false) => SessionChannel.of({
  publish: () => Effect.void,
  subscribe: (address) => {
    followed.push(address)
    return failing ? Stream.fail(new SessionChannelError({ reason: "unavailable", message: "the broker is down" })) : Stream.fromIterable(payloads)
  },
})

const liveOf = (feed: ReturnType<typeof feedOf>, channel: SessionChannel["Service"]) =>
  Effect.runPromise(sessionLive(feed).pipe(Effect.provideService(SessionChannel, channel)))

describe("sessionLive", () => {
  test("follows the feed's session as its principal and sends the channel's payloads as transient frames after ready", async () => {
    const followed: Array<SessionAddress> = []
    const live = await liveOf(feedOf(), channelOf(followed, [preview]))
    const frames = await Effect.runPromise(Effect.gen(function* () {
      const journal = yield* makeMemoryJournal([{ sequence: 1, kind: "turn.started", data: {}, turn: 1 }])
      const feed = makeRenderFeed(journal.tail, { pollMs: 5, maxPollMs: 10, heartbeatMs: 10_000, maxDurationMs: 2_000 })
      return yield* feed.frames(feedOf(), 0, (record) => Effect.succeed(Option.some({ event: record.kind, data: record.data })), { live }).pipe(
        Stream.takeUntil((frame) => frame._tag === "FeedTransient"),
        Stream.runCollect,
      )
    }))
    expect(frames.map((frame) => frame._tag)).toEqual(["FeedRecord", "FeedReady", "FeedTransient"])
    expect(frames.at(-1)).toEqual({ _tag: "FeedTransient", event: "app.preview", data: { html: "<p>draft</p>" } })
    expect(followed).toEqual([{ id, owner: "owner-1" }])
  })

  test("a name that is not a session fails with invalid, a channel that cannot be reached with unavailable", async () => {
    const followed: Array<SessionAddress> = []
    const invalid = await Effect.runPromise(Effect.flip(Stream.runDrain(await liveOf(feedOf("not-a-session"), channelOf(followed, [preview])))))
    const unreachable = await Effect.runPromise(Effect.flip(Stream.runDrain(await liveOf(feedOf(), channelOf(followed, [], true)))))
    expect([invalid.code, unreachable.code]).toEqual(["invalid", "unavailable"])
    expect(followed).toEqual([{ id, owner: "owner-1" }])
  })
})
