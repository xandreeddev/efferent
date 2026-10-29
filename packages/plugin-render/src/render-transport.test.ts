import { expect, test } from "bun:test"
import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { Socket } from "node:net"
import type { AddressInfo } from "node:net"
import { Effect, Logger, Option, Result, Stream } from "effect"
import { FeedReady, FeedRecord } from "./domain/feed-frame.entity.js"
import { RenderError } from "./domain/render-surface.entity.js"
import { decodeSse, encodeSse, nextPollMs, socketResumeOf, ssePreamble } from "./domain/feed-frame.entity.functions.js"
import { makeRenderFeed } from "./render-feed.adapter.js"
import { SseTransport, sseNodePeer, WebSocketTransport } from "./render-transport.adapter.js"
import { renderFeedConformance, renderTransportConformance } from "./render-transport.conformance.js"

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
    decodeSse("event: surface.planned\ndata: {}\n\n"),
  ]
  expect(decoded.map((result) => Result.isFailure(result) ? result.failure.code : "decoded")).toEqual(["invalid", "invalid", "invalid"])
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
