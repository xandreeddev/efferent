import { Effect, Option, Stream } from "effect"
import type { Duration } from "effect"
import type { ServerResponse } from "node:http"
import { encodeSocketFrame, encodeSse, ssePreamble } from "./domain/feed-frame.entity.functions.js"
import type { RenderError } from "./domain/render-surface.entity.js"
import type { SseContentEncoding } from "./domain/sse-encoding.entity.js"
import { sseContentEncodingOf } from "./domain/sse-encoding.entity.functions.js"
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

/**
 * Server-Sent Events: a retry preamble, then one block per frame until the feed ends or the client leaves.
 * When the frames end (the feed's `maxDurationMs`, or a failed feed) it ends the peer, once; a client that
 * left is never ended.
 */
export const SseTransport: RenderTransport<SsePeer> = {
  id: "sse",
  serve: (frames, peer) => peer.write(ssePreamble).pipe(
    Effect.andThen(Stream.runForEach(frames, (frame) => peer.write(encodeSse(frame)))),
    Effect.catch(logFeedFailure("sse")),
    Effect.andThen(peer.end),
    Effect.raceFirst(peer.closed),
  ),
}

/**
 * One JSON text frame per feed frame. Clients resume by sending `{"after": <sequence>}` or the host's equivalent.
 *
 * @public
 */
export const WebSocketTransport: RenderTransport<SocketPeer> = {
  id: "websocket",
  serve: (frames, peer) => Stream.runForEach(frames, (frame) => peer.send(encodeSocketFrame(frame))).pipe(
    Effect.catch(logFeedFailure("websocket")),
    Effect.raceFirst(peer.closed),
  ),
}

/** Where `sseNodePeer` writes: the response itself, or a compressor piped into it. */
interface ResponseSink {
  readonly encoding: SseContentEncoding
  /** Writes a chunk and calls `taken` once it has left for the response (compressed and flushed, when compressing). */
  readonly write: (chunk: string, taken: () => void) => void
  readonly end: () => void
  readonly destroy: () => void
}

const identitySink = (response: ServerResponse): ResponseSink => ({
  encoding: "identity",
  write: (chunk, taken) => { response.write(chunk, () => taken()) },
  end: () => { response.end() },
  destroy: () => { response.destroy() },
})

/**
 * A Brotli (text mode, quality 5) or gzip compressor piped into the response, one compression window for the
 * whole connection, flushed after every write so no frame waits for the next. It is destroyed when the
 * response closes; a compressor that fails drops the client.
 */
const compressedSink = (response: ServerResponse, encoding: "br" | "gzip") =>
  Effect.tryPromise(() => import("node:zlib")).pipe(Effect.map((zlib): ResponseSink => {
    const compressor = encoding === "br"
      ? zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } })
      : zlib.createGzip()
    const flush = encoding === "br" ? zlib.constants.BROTLI_OPERATION_FLUSH : zlib.constants.Z_SYNC_FLUSH
    compressor.on("error", () => { response.destroy() })
    response.once("close", () => { compressor.destroy() })
    compressor.pipe(response)
    return {
      encoding,
      write: (chunk, taken) => {
        compressor.write(chunk)
        compressor.flush(flush, () => taken())
      },
      end: () => { if (!compressor.writableEnded) compressor.end() },
      destroy: () => {
        compressor.destroy()
        response.destroy()
      },
    }
  }))

/** The sink a request's `Accept-Encoding` asks for; identity when the runtime has no compressor to give. */
const sinkFor = (response: ServerResponse, acceptEncoding: string): Effect.Effect<ResponseSink> => {
  const encoding = sseContentEncodingOf(acceptEncoding)
  return encoding === "identity" ? Effect.succeed(identitySink(response)) : compressedSink(response, encoding).pipe(
    Effect.catch((error) => Effect.logWarning("an SSE response is sent uncompressed: the runtime has no compressor", error).pipe(
      Effect.as(identitySink(response)))),
  )
}

/** The headers of a negotiated response: its `content-encoding`, and `accept-encoding` added to the host's `vary`. */
const codingHeaders = (sink: ResponseSink, headers: Readonly<Record<string, string>>): Record<string, string> => ({
  vary: Option.match(Option.fromNullishOr(headers["vary"]), { onNone: () => "accept-encoding", onSome: (vary) => `${vary}, accept-encoding` }),
  ...(sink.encoding === "identity" ? {} : { "content-encoding": sink.encoding }),
})

/** Completes once the response has finished sending, or has closed. */
const settled = (response: ServerResponse) => Effect.callback<void>((resume) => {
  if (response.writableFinished || response.closed) return resume(Effect.void)
  const done = () => resume(Effect.void)
  response.once("finish", done)
  response.once("close", done)
  return Effect.sync(() => {
    response.off("finish", done)
    response.off("close", done)
  })
})

/**
 * An SSE peer over a Node HTTP response: writes the SSE headers and completes
 * `closed` on disconnect. A write the client has not taken within `timeout`
 * drops it: the response is destroyed, so `closed` completes and the feed stops.
 * `end` ends the response and waits, as long again, for it to finish.
 *
 * With `compress`, the request's `Accept-Encoding`, the response is sent in
 * Brotli when the client takes it, else gzip, else uncompressed
 * (`sseContentEncodingOf`), with `content-encoding` and `vary: accept-encoding`;
 * every write is flushed, so each frame reaches the client as it is written.
 */
export const sseNodePeer = (
  response: ServerResponse,
  headers: Readonly<Record<string, string>> = {},
  timeout: Duration.Input = "2 seconds",
  options: { readonly compress?: string | undefined } = {},
): Effect.Effect<SsePeer> => Option.match(Option.fromNullishOr(options.compress), {
  onNone: () => Effect.succeed({ sink: identitySink(response), coding: {} }),
  onSome: (acceptEncoding) => sinkFor(response, acceptEncoding).pipe(Effect.map((sink) => ({ sink, coding: codingHeaders(sink, headers) }))),
}).pipe(Effect.map(({ sink, coding }) => {
  response.writeHead(200, { ...sseHeaders, ...headers, ...coding })
  const drop = () => Effect.sync(() => { sink.destroy() })
  return {
    write: (chunk: string) => Effect.callback<void>((resume) => {
      sink.write(chunk, () => resume(Effect.void))
    }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: drop })),
    closed: Effect.callback<void>((resume) => {
      if (response.closed) return resume(Effect.void)
      const leave = () => resume(Effect.void)
      response.once("close", leave)
      return Effect.sync(() => { response.off("close", leave) })
    }),
    end: Effect.sync(() => { sink.end() }).pipe(
      Effect.andThen(settled(response)),
      Effect.timeoutOrElse({ duration: timeout, orElse: drop }),
    ),
  }
}))
