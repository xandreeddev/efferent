import { Effect, Stream } from "effect"
import type { ServerResponse } from "node:http"
import { encodeSocketFrame, encodeSse, ssePreamble } from "./domain/feed-frame.entity.functions.js"
import type { RenderTransport, SocketPeer, SsePeer } from "./ports/render.port.js"

export const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  connection: "keep-alive",
  "x-accel-buffering": "no",
} as const

/** Server-Sent Events: a retry preamble, then one block per frame until the feed ends or the client leaves. */
export const SseTransport: RenderTransport<SsePeer> = {
  id: "sse",
  serve: (frames, peer) => peer.write(ssePreamble).pipe(
    Effect.zipRight(Stream.runForEach(frames, (frame) => peer.write(encodeSse(frame)))),
    Effect.catchAll(() => Effect.void),
    Effect.raceFirst(peer.closed),
  ),
}

/** One JSON text frame per feed frame. Clients resume by sending `{"after": <sequence>}` or the host's equivalent. */
export const WebSocketTransport: RenderTransport<SocketPeer> = {
  id: "websocket",
  serve: (frames, peer) => Stream.runForEach(frames, (frame) => peer.send(encodeSocketFrame(frame))).pipe(
    Effect.catchAll(() => Effect.void),
    Effect.raceFirst(peer.closed),
  ),
}

/** An SSE peer over a Node HTTP response: writes the SSE headers and completes `closed` on disconnect. */
export const sseNodePeer = (response: ServerResponse, headers: Readonly<Record<string, string>> = {}): Effect.Effect<SsePeer> => Effect.sync(() => {
  response.writeHead(200, { ...sseHeaders, ...headers })
  return {
    write: (chunk: string) => Effect.async<void>((resume) => {
      response.write(chunk, () => resume(Effect.void))
    }),
    closed: Effect.async<void>((resume) => {
      if (response.closed) resume(Effect.void)
      else response.once("close", () => resume(Effect.void))
    }),
  }
})
