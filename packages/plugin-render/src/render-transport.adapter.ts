import { Effect, Stream } from "effect"
import type { Duration } from "effect"
import type { ServerResponse } from "node:http"
import { encodeSocketFrame, encodeSse, ssePreamble } from "./domain/feed-frame.entity.functions.js"
import type { RenderError } from "./domain/render-surface.entity.js"
import type { RenderTransport, SocketPeer, SsePeer } from "./ports/render.port.js"

export const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const

/** A feed that fails ends the connection as a finished one does; the failure is logged, not sent. */
const logFeedFailure = (transport: string) => (error: RenderError) =>
  Effect.logWarning(`the render feed over ${transport} ended with ${error.code}: ${error.message}`)

/** Server-Sent Events: a retry preamble, then one block per frame until the feed ends or the client leaves. */
export const SseTransport: RenderTransport<SsePeer> = {
  id: "sse",
  serve: (frames, peer) => peer.write(ssePreamble).pipe(
    Effect.andThen(Stream.runForEach(frames, (frame) => peer.write(encodeSse(frame)))),
    Effect.catch(logFeedFailure("sse")),
    Effect.raceFirst(peer.closed),
  ),
}

/** One JSON text frame per feed frame. Clients resume by sending `{"after": <sequence>}` or the host's equivalent. */
export const WebSocketTransport: RenderTransport<SocketPeer> = {
  id: "websocket",
  serve: (frames, peer) => Stream.runForEach(frames, (frame) => peer.send(encodeSocketFrame(frame))).pipe(
    Effect.catch(logFeedFailure("websocket")),
    Effect.raceFirst(peer.closed),
  ),
}

/**
 * An SSE peer over a Node HTTP response: writes the SSE headers and completes
 * `closed` on disconnect. A write the client has not taken within `timeout`
 * drops it: the response is destroyed, so `closed` completes and the feed stops.
 */
export const sseNodePeer = (
  response: ServerResponse,
  headers: Readonly<Record<string, string>> = {},
  timeout: Duration.Input = "2 seconds",
): Effect.Effect<SsePeer> => Effect.sync(() => {
  response.writeHead(200, { ...sseHeaders, ...headers })
  return {
    write: (chunk: string) => Effect.callback<void>((resume) => {
      response.write(chunk, () => resume(Effect.void))
    }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.sync(() => { response.destroy() }) })),
    closed: Effect.callback<void>((resume) => {
      if (response.closed) return resume(Effect.void)
      const leave = () => resume(Effect.void)
      response.once("close", leave)
      return Effect.sync(() => { response.off("close", leave) })
    }),
  }
})
