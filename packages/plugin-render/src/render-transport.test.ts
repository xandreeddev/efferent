import { expect, test } from "bun:test"
import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import type { AddressInfo } from "node:net"
import { Effect, Logger, Option, Result, Schema, Stream } from "effect"
import { RunId } from "@xandreed/core"
import { FeedReady, FeedRecord, FeedTransient } from "./domain/feed-frame.entity.js"
import type { FeedFrame } from "./domain/feed-frame.entity.js"
import { PrincipalId, RenderMessageId, ThreadId } from "./domain/render-output.entity.js"
import { RenderError, SurfaceId } from "./domain/render-surface.entity.js"
import type { VersionId } from "./domain/render-surface.entity.js"
import { decodeSocketFrame, decodeSse, encodeSocketFrame, encodeSse, nextPollMs, payloadOf, socketResumeOf, ssePreamble, transientOf } from "./domain/feed-frame.entity.functions.js"
import { RenderStore } from "./ports/render.port.js"
import type { FeedProjection } from "./ports/render.port.js"
import { makeRenderFeed } from "./render-feed.adapter.js"
import { MemoryRenderStoreLive } from "./render-store.memory.adapter.js"
import { SseTransport, sseNodePeer, WebSocketTransport } from "./render-transport.adapter.js"
import { makeMemoryJournal, renderFeedConformance, renderTransportConformance } from "./render-transport.conformance.js"

renderTransportConformance({ sse: SseTransport, socket: WebSocketTransport }).forEach((check) => {
  test(`transport conformance: ${check.name}`, async () => {
    await Effect.runPromise(check.run)
  })
})

renderFeedConformance(makeRenderFeed).forEach((check) => {
  test(`feed conformance: ${check.name}`, async () => {
    await Effect.runPromise(check.run)
  })
})

test("the SSE wire format", () => {
  expect(ssePreamble).toBe("retry: 1000\n\n")
  expect(encodeSse(FeedRecord.make({ sequence: 7, event: "surface.planned", data: { a: 1 } }))).toBe("id: 7\nevent: surface.planned\ndata: {\"a\":1}\n\n")
  expect(encodeSse(FeedReady.make({}))).toBe("event: ready\ndata: {}\n\n")
  expect(decodeSse("retry: 1000\n\n: heartbeat\n\n")).toEqual(Result.succeed([{ _tag: "FeedHeartbeat" }]))
})

test("a malformed SSE record is a typed failure, not a throw", () => {
  const decoded = [
    decodeSse("id: -1\nevent: surface.planned\ndata: {}\n\n"),
    decodeSse("id: 2\nevent: surface.planned\ndata: [1]\n\n"),
    decodeSse("event: surface.planned\n\n"),
    decodeSse("data: {}\n\n"),
    decodeSse("event: preview\ndata: [1]\n\n"),
  ]
  expect(decoded.map((result) => Result.isFailure(result) ? result.failure.code : "decoded")).toEqual(["invalid", "invalid", "invalid", "invalid", "invalid"])
})

test("a transient frame has no id on SSE and its own type on a socket", () => {
  const transient = FeedTransient.make({ event: "reply.delta", data: { text: "Hel" } })
  expect(encodeSse(transient)).toBe("event: reply.delta\ndata: {\"text\":\"Hel\"}\n\n")
  expect(encodeSocketFrame(transient)).toBe("{\"type\":\"transient\",\"event\":\"reply.delta\",\"data\":{\"text\":\"Hel\"}}")
  expect(decodeSse(`${ssePreamble}${encodeSse(FeedRecord.make({ sequence: 3, event: "turn.started", data: {} }))}${encodeSse(transient)}`)).toEqual(
    Result.succeed([FeedRecord.make({ sequence: 3, event: "turn.started", data: {} }), transient]))
  expect(decodeSocketFrame(encodeSocketFrame(transient))).toEqual(Option.some(transient))
})

test("ready is the feed's own frame: a record may carry the name, a transient frame may not", () => {
  expect(decodeSse("id: 4\nevent: ready\ndata: {\"a\":1}\n\n")).toEqual(Result.succeed([FeedRecord.make({ sequence: 4, event: "ready", data: { a: 1 } })]))
  expect(decodeSse("event: ready\ndata: {}\n\n")).toEqual(Result.succeed([FeedReady.make({})]))
  expect(decodeSocketFrame("{\"type\":\"transient\",\"event\":\"ready\",\"data\":{}}")).toEqual(Option.none())
  const refused = transientOf({ event: "ready", data: {} })
  expect(Result.isFailure(refused) ? refused.failure.code : "accepted").toBe("invalid")
  expect(transientOf({ event: "preview", data: { a: 1 } })).toEqual(Result.succeed(FeedTransient.make({ event: "preview", data: { a: 1 } })))
})

test("a live payload named ready fails the feed, which either wire ends quietly", async () => {
  const feed = makeRenderFeed({ read: () => Effect.succeed([]) }, { pollMs: 5, maxPollMs: 10, heartbeatMs: 1_000, maxDurationMs: 1_000 })
  const failed = await Effect.runPromise(Stream.runCollect(feed.frames(
    { threadId: ThreadId.make("thread"), principalId: PrincipalId.make("guest") }, 0, () => Effect.succeed(Option.none()), Stream.make({ event: "ready", data: {} }),
  )).pipe(Effect.flip))
  expect(failed.code).toBe("invalid")
})

test("transient frames never move the cursor a client resumes from", async () => {
  const feed = makeRenderFeed({ read: (_feed, after) => Effect.succeed([{ sequence: 5, kind: "turn.started", data: {} }].filter((record) => record.sequence > after)) },
    { pollMs: 5, maxPollMs: 10, heartbeatMs: 1_000, maxDurationMs: 60 })
  const written: Array<string> = []
  await Effect.runPromise(SseTransport.serve(feed.frames(
    { threadId: ThreadId.make("thread"), principalId: PrincipalId.make("guest") }, 0,
    (record) => Effect.succeed(Option.some({ event: record.kind, data: record.data })),
    Stream.make({ event: "reply.delta", data: { text: "a" } }, { event: "reply.delta", data: { text: "b" } }),
  ), { write: (chunk) => Effect.sync(() => { written.push(chunk) }), closed: Effect.never }))
  // What an EventSource keeps as its last event id: the last id line written, never one of a transient block.
  const ids = written.join("").split("\n").filter((line) => line.startsWith("id: "))
  expect(ids).toEqual(["id: 5"])
  const frames = decodeSse(written.join(""))
  expect(Result.map(frames, (all) => all.filter((frame) => frame._tag !== "FeedHeartbeat").map((frame) => frame._tag))).toEqual(
    Result.succeed(["FeedRecord", "FeedReady", "FeedTransient", "FeedTransient"]))
})

test("a feed that fails ends either wire quietly for the client and logs why", async () => {
  const logged: Array<string> = []
  const capture = Logger.layer([Logger.make((options) => logged.push([options.message].flat().join(" ")))])
  const failing = Stream.fail(new RenderError({ code: "forbidden", message: "no such session" }))
  await Effect.runPromise(Effect.gen(function* () {
    yield* SseTransport.serve(failing, { write: () => Effect.void, closed: Effect.never })
    yield* WebSocketTransport.serve(failing, { send: () => Effect.void, closed: Effect.never })
  }).pipe(Effect.provide(capture)))
  expect(logged).toEqual([
    "the render feed over sse ended with forbidden: no such session",
    "the render feed over websocket ended with forbidden: no such session",
  ])
})

/** A response whose writes are never flushed: a client that stopped reading. */
const stalledResponse = () => new ServerResponse(new IncomingMessage(new Socket()))

test("an SSE write the client does not take in time drops the client and ends the feed", async () => {
  const response = stalledResponse()
  const served = await Effect.runPromise(sseNodePeer(response, {}, "20 millis").pipe(
    Effect.flatMap((peer) => SseTransport.serve(Stream.never, peer)),
    Effect.timeoutOption("2 seconds"),
  ))
  expect([Option.isSome(served), response.destroyed]).toEqual([true, true])
})

test("an SSE peer stops listening for the close once nothing waits on it", async () => {
  const response = stalledResponse()
  const before = response.listenerCount("close")
  await Effect.runPromise(sseNodePeer(response).pipe(Effect.flatMap((peer) => peer.closed.pipe(Effect.timeoutOption("10 millis")))))
  expect(response.listenerCount("close")).toBe(before)
})

test("idle polling backs off and records reset it", () => {
  const options = { pollMs: 100, maxPollMs: 1000, heartbeatMs: 15_000, maxDurationMs: 240_000 }
  expect(nextPollMs(0, options, false)).toBe(100)
  expect(nextPollMs(400, options, false)).toBe(800)
  expect(nextPollMs(800, options, false)).toBe(1000)
  expect(nextPollMs(800, options, true)).toBe(100)
})

test("a WebSocket client resumes after the cursor it sends", () => {
  expect(socketResumeOf("{\"after\":12}")).toEqual(Option.some(12))
  expect(socketResumeOf("hello")).toEqual(Option.none())
})

test("SSE over a Node HTTP response reaches a real client", async () => {
  const frames = [FeedRecord.make({ sequence: 1, event: "message.updated", data: { text: "hi" } }), FeedReady.make({})]
  const server = createServer((_request, response) => {
    Effect.runFork(sseNodePeer(response).pipe(
      Effect.flatMap((peer) => SseTransport.serve(Stream.fromIterable(frames), peer)),
      Effect.ensuring(Effect.sync(() => response.end())),
    ))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  const response = await fetch(`http://127.0.0.1:${port}/`)
  const text = await response.text()
  server.close()
  expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8")
  expect(text.startsWith(ssePreamble)).toBe(true)
  expect(decodeSse(text)).toEqual(Result.succeed(frames))
})

/** A host's own client event: its encoded form (a number as text, an optional field) is not typed as JSON. */
const Shown = Schema.Struct({ text: Schema.String, at: Schema.NumberFromString, note: Schema.optional(Schema.String), versions: Schema.Int })
const shown = payloadOf(Shown)
const surface = {
  threadId: ThreadId.make("thread"), runId: RunId.make("run"), messageId: RenderMessageId.make("answer"), principalId: PrincipalId.make("guest"),
  fence: 1, surfaceId: SurfaceId.make("page"), baseVersion: Option.none<VersionId>(),
}

test("payloadOf encodes a host's schema into a payload, dropping undefined fields", async () => {
  const payload = await Effect.runPromise(shown("message.updated", { text: "hi", at: 3, note: undefined, versions: 1 }))
  expect(payload).toEqual({ event: "message.updated", data: { text: "hi", at: "3", versions: 1 } })
  expect(FeedRecord.make({ sequence: 1, ...payload })).toEqual({ _tag: "FeedRecord", sequence: 1, event: "message.updated", data: { text: "hi", at: "3", versions: 1 } })
})

test("payloadOf refuses JSON it cannot carry and an empty event as invalid", async () => {
  const failures = await Effect.runPromise(Effect.all([
    Effect.flip(payloadOf(Schema.Struct({ count: Schema.BigInt }))("counted", { count: 1n })),
    Effect.flip(shown(" ", { text: "hi", at: 1, versions: 0 })),
  ], { concurrency: 1 }))
  expect(failures.map((failure) => failure.code)).toEqual(["invalid", "invalid"])
  expect(failures[0]?.message.startsWith("Invalid feed payload counted: ")).toBe(true)
})

test("a projection that reads a store requires it on the feed's stream, provided where the stream runs", async () => {
  const withVersions: FeedProjection<RenderStore> = (record) => Effect.gen(function* () {
    const records = yield* (yield* RenderStore).hydrate(surface)
    return Option.some(yield* shown(record.kind, { text: "hi", at: record.sequence, versions: records.length }))
  })
  const options = { pollMs: 5, maxPollMs: 10, heartbeatMs: 1_000, maxDurationMs: 1_000 }
  const frames = await Effect.runPromise(Effect.gen(function* () {
    const journal = yield* makeMemoryJournal([{ sequence: 1, kind: "message.updated", data: {} }])
    const stream: Stream.Stream<FeedFrame, RenderError, RenderStore> = makeRenderFeed(journal.tail, options).frames({ threadId: surface.threadId, principalId: surface.principalId }, 0, withVersions)
    return yield* Stream.runCollect(stream.pipe(Stream.takeUntil((frame) => frame._tag === "FeedReady")))
  }).pipe(Effect.provide(MemoryRenderStoreLive)))
  expect(Array.from(frames)).toEqual([
    FeedRecord.make({ sequence: 1, event: "message.updated", data: { text: "hi", at: "1", versions: 0 } }),
    FeedReady.make({}),
  ])
})
