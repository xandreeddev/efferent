import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Effect, Match, Option, Redacted, Result } from "effect"
import { release } from "node:os"
import WebSocket from "ws"
import type { WebSocketProxy } from "../ports/models-transport.port.js"
import { redactCredentials } from "../transport/http-proxy.entity.functions.js"
import { currentRuntime } from "../transport/models-transport.adapter.js"
import { OPENAI_CODEX_ORIGINATOR } from "../auth/openAiCodexOAuth.js"

const WEBSOCKET_BETA = "responses_websockets=2026-02-06"
const sessionIds = new Map<string, string>()

type Json = Record<string, unknown>

const decodeBody = (request: Parameters<Parameters<typeof HttpClient.make>[0]>[0]): Json => {
  if (request.body._tag !== "Uint8Array") return {}
  const text = new TextDecoder().decode(request.body.body)
  const parsed: unknown = JSON.parse(text)
  return typeof parsed === "object" && parsed !== null ? parsed as Json : {}
}

const websocketUrl = (url: URL): string => {
  const next = new URL(url)
  next.protocol = next.protocol === "http:" ? "ws:" : "wss:"
  return next.toString()
}

/** ChatGPT's Luna router currently keys its internal route on a
 * time-ordered UUIDv7 session id; UUIDv4 reaches a nonexistent rollout
 * alias. Keep one v7 id per Efferent conversation/cache key. */
export const openAiCodexUuidV7 = (now = Date.now()): string => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  const timestamp = BigInt(now)
  bytes[0] = Number((timestamp >> 40n) & 0xffn)
  bytes[1] = Number((timestamp >> 32n) & 0xffn)
  bytes[2] = Number((timestamp >> 24n) & 0xffn)
  bytes[3] = Number((timestamp >> 16n) & 0xffn)
  bytes[4] = Number((timestamp >> 8n) & 0xffn)
  bytes[5] = Number(timestamp & 0xffn)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const sessionIdFor = (cacheKey: unknown): string => {
  const key = typeof cacheKey === "string" && cacheKey.length > 0 ? cacheKey : globalThis.crypto.randomUUID()
  const existing = sessionIds.get(key)
  if (existing !== undefined) return existing
  const created = openAiCodexUuidV7()
  sessionIds.set(key, created)
  return created
}

const eventText = (data: unknown): string | undefined => {
  if (typeof data === "string") return data
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(data))
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }
  return undefined
}

/** Codex currently names the WebSocket terminal event `response.done`; the
 * public Responses stream consumed by @effect/ai names it `response.completed`. */
export const normalizeOpenAiCodexWebSocketEvent = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value
  const event = value as Json
  return event["type"] === "response.done"
    ? { ...event, type: "response.completed" }
    : event
}

/** `value` as a record, when it is one. */
const recordOf = (value: unknown): Option.Option<Json> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Option.some(value as Json) : Option.none()
const stringOf = (value: unknown): Option.Option<string> => typeof value === "string" ? Option.some(value) : Option.none()

/**
 * The OpenAI error body of an `error` frame that refuses the request, which
 * the HTTP Responses endpoint would answer with a 400: the frame's status is
 * 400, its error's type or code is `invalid_request_error`, or its message
 * names an image. The error is the frame's `error` object, or the frame
 * itself (the Responses stream's own `error` event). Any other frame: none.
 */
export const openAiCodexRefusal = (event: unknown): Option.Option<Json> => Option.flatMap(
  Option.filter(recordOf(event), (frame) => frame["type"] === "error"),
  (frame) => {
    const error = Option.getOrElse(recordOf(frame["error"]), () => frame)
    const message = Option.getOrElse(stringOf(error["message"]), () => "")
    const type = stringOf(error["type"])
    const code = stringOf(error["code"])
    const refused = frame["status"] === 400 || /image/i.test(message)
      || Option.contains(type, "invalid_request_error") || Option.contains(code, "invalid_request_error")
    return refused
      ? Option.some({ error: {
        message: message.length > 0 ? message : "the request was refused",
        type: Option.getOrElse(Option.filter(type, (value) => value !== "error"), () => "invalid_request_error"),
        code: Option.getOrNull(code),
        param: Option.getOrNull(stringOf(error["param"])),
      } })
      : Option.none()
  },
)

export const isOpenAiCodexControlEvent = (type: unknown): boolean =>
  typeof type === "string" && (type.startsWith("codex.") || type === "responsesapi.websocket_timing")

/** What the client uses of a WebSocket, whichever implementation opened it. */
interface CodexSocket {
  readonly send: (data: string) => void
  readonly close: (code: number, reason: string) => void
  readonly onOpen: (listener: () => void) => void
  readonly onMessage: (listener: (data: unknown) => void) => void
  readonly onError: (listener: (error: Error) => void) => void
  readonly onClose: (listener: (code: number, reason: string) => void) => void
}

/** A socket of the `ws` client (on Bun, Bun's stand-in for it, which takes neither an agent nor a proxy). */
const wsSocket = (socket: WebSocket): CodexSocket => ({
  send: (data) => socket.send(data),
  close: (code, reason) => socket.close(code, reason),
  onOpen: (listener) => socket.addEventListener("open", () => listener()),
  onMessage: (listener) => socket.addEventListener("message", (event) => listener(event.data)),
  onError: (listener) => socket.addEventListener("error", (event) =>
    listener(event.error instanceof Error ? event.error : new Error(event.message || "WebSocket handshake failed"))),
  onClose: (listener) => socket.addEventListener("close", (event) => listener(event.code, event.reason)),
})

/**
 * Bun's own WebSocket, which takes `headers` and a `proxy` in its options.
 * The DOM declaration of `WebSocket` (the one in force with the DOM library)
 * has no options argument, so the constructor is called through `Reflect`.
 */
const bunSocket = (url: string, options: { readonly headers: Record<string, string>; readonly proxy: string }): CodexSocket => {
  const socket: globalThis.WebSocket = Reflect.construct(globalThis.WebSocket, [url, options])
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
    onOpen: (listener) => socket.addEventListener("open", () => listener()),
    onMessage: (listener) => socket.addEventListener("message", (event) => listener(event.data)),
    onError: (listener) => socket.addEventListener("error", (event) =>
      listener(new Error("message" in event && typeof event.message === "string" && event.message.length > 0 ? event.message : "WebSocket handshake failed"))),
    onClose: (listener) => socket.addEventListener("close", (event) => listener(event.code, event.reason)),
  }
}

/** Open the socket: directly, with a Node agent (one that tunnels to the proxy, or a plain one), or through Bun's `proxy` option. */
const openSocket = (url: string, headers: Record<string, string>, proxy: Option.Option<WebSocketProxy>): CodexSocket =>
  Option.match(proxy, {
    onNone: () => wsSocket(new WebSocket(url, { headers })),
    onSome: (route) => Match.value(route).pipe(
      Match.tag("Agent", ({ agent }) => wsSocket(new WebSocket(url, { headers, agent }))),
      Match.tag("Proxy", ({ url: proxyUrl }) => bunSocket(url, { headers, proxy: Redacted.value(proxyUrl) })),
      Match.exhaustive,
    ),
  })

/**
 * Why this runtime cannot use `route`, if it cannot: an `Agent` is for the
 * `ws` client on Node (Bun's stand-in for `ws` takes no agent), a `Proxy` for
 * Bun's own `WebSocket` (Node's ignores a `proxy` option). Either would
 * connect directly past the proxy, so the call fails instead.
 */
const routeMismatch = (route: WebSocketProxy): Option.Option<string> => {
  const runtime = currentRuntime()
  return Match.value(route).pipe(
    Match.tag("Agent", () => runtime._tag === "Node" ? Option.none() : Option.some(`the WebSocket route is a Node agent, which ${runtime._tag === "Bun" ? "Bun's WebSocket" : "this runtime's WebSocket"} cannot use`)),
    Match.tag("Proxy", () => runtime._tag === "Bun" ? Option.none() : Option.some("the WebSocket route is a proxy URL for Bun's WebSocket, which this runtime's WebSocket would ignore")),
    Match.exhaustive,
    Option.map((why) => `${why}: refused rather than connecting directly past the proxy`),
  )
}

/** A failed subscription request, as the HTTP client reports it (credentials redacted). */
const transportFailure = (request: HttpClientRequest.HttpClientRequest, cause: unknown) => new HttpClientError.HttpClientError({
  reason: new HttpClientError.TransportError({
    request: request.pipe(
      HttpClientRequest.setHeader("authorization", "[redacted]"),
      HttpClientRequest.setHeader("chatgpt-account-id", "[redacted]"),
    ),
    description: `OpenAI subscription WebSocket failed: ${
      redactCredentials(cause instanceof Error ? cause.message : String(cause))
    }`,
    cause,
  }),
})

/** Adapt the ChatGPT Codex WebSocket protocol to an SSE-shaped HttpClient
 * response. OpenAiLanguageModel remains the sole protocol decoder, so text,
 * reasoning, tool calls, tool results, usage, and errors keep their standard
 * Effect representations instead of being reimplemented here. `proxy` is how
 * the socket reaches ChatGPT (`ModelsTransport.webSocketAgent`); `None`
 * connects directly. A route this runtime cannot use fails every request.
 * The response is the stream once the first event arrives, unless that
 * event is an `error` refusing the request (`openAiCodexRefusal`): the
 * request then fails with a 400 status and the OpenAI error body, as the
 * HTTP endpoint answers it, so a refused image is an `InvalidRequestError`. */
export const makeOpenAiCodexWebSocketHttpClient = (proxy: Option.Option<WebSocketProxy>) => HttpClient.make(
  (request, url, signal) => Option.match(Option.flatMap(proxy, routeMismatch), {
    onSome: (why) => Effect.fail(transportFailure(request, new Error(why))),
    onNone: () => Effect.tryPromise({
      try: () => new Promise<HttpClientResponse.HttpClientResponse>((resolve, reject) => {
        const body = decodeBody(request)
        const safeRequest = request.pipe(
          HttpClientRequest.setHeader("authorization", "[redacted]"),
          HttpClientRequest.setHeader("chatgpt-account-id", "[redacted]"),
        )
        // A WebSocket upgrade has a deliberately smaller header contract than
        // the HTTP request. In particular, forwarding content-length or HTTP
        // tracing headers causes the Codex upgrade to terminate silently.
        const headers: Record<string, string> = Object.fromEntries(
          ["authorization", "chatgpt-account-id", "originator"].flatMap((key) => {
            const value = request.headers[key]
            return value === undefined ? [] : [[key, value]]
          }),
        )
        headers["openai-beta"] = WEBSOCKET_BETA
        headers["user-agent"] = `${OPENAI_CODEX_ORIGINATOR} (${process.platform} ${release()}; ${process.arch})`
        const requestId = sessionIdFor(body["prompt_cache_key"])
        body["prompt_cache_key"] = requestId
        headers["session-id"] = requestId
        headers["x-client-request-id"] = requestId

        const socket = openSocket(websocketUrl(url), headers, proxy)
        // `connecting` until the request is sent, `sent` until its first event
        // decides the response, then `settled`.
        const state: {
          phase: "connecting" | "sent" | "settled"
          controller?: ReadableStreamDefaultController<Uint8Array>
        } = { phase: "connecting" }
        const stream = new ReadableStream<Uint8Array>({
          start: (value) => {
            state.controller = value
          },
          cancel: () => socket.close(1000, "cancelled"),
        })
        const respond = (response: Response) => {
          state.phase = "settled"
          resolve(HttpClientResponse.fromWeb(safeRequest, response))
        }
        // The response is the event stream, from the first event on.
        const streaming = () => {
          if (state.phase === "sent") respond(new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }))
        }

        const fail = (cause: unknown) => {
          if (state.phase === "connecting") {
            state.phase = "settled"
            reject(cause)
          } else {
            streaming()
            state.controller?.error(cause)
          }
          socket.close(1011, "transport error")
        }
        const abort = () => fail(new Error("OpenAI subscription request aborted"))
        signal.addEventListener("abort", abort, { once: true })

        socket.onOpen(() => {
          Result.match(Result.try(() => {
            socket.send(JSON.stringify({ type: "response.create", ...body }))
            state.phase = "sent"
          }), { onFailure: fail, onSuccess: () => undefined })
        })
        socket.onMessage((data) => {
          Result.match(Result.try(() => {
            const text = eventText(data)
            if (text === undefined) return
            const parsed = normalizeOpenAiCodexWebSocketEvent(JSON.parse(text)) as Json
            const type = parsed["type"]
            // Subscription-only control frames are not Responses API events.
            // They are consumed out-of-band; the Effect model decoder should
            // see only the standard response stream vocabulary.
            if (isOpenAiCodexControlEvent(type)) return
            // A request refused before any event is a 400, as over HTTP.
            const refused = state.phase === "sent" ? openAiCodexRefusal(parsed) : Option.none()
            if (Option.isSome(refused)) {
              respond(new Response(JSON.stringify(refused.value), { status: 400, headers: { "content-type": "application/json" } }))
              signal.removeEventListener("abort", abort)
              socket.close(1000, "refused")
              return
            }
            streaming()
            if (type === "error") {
              fail(new Error(JSON.stringify(parsed)))
              return
            }
            state.controller?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(parsed)}\n\n`))
            if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
              state.controller?.close()
              signal.removeEventListener("abort", abort)
              socket.close(1000, "done")
            }
          }), { onFailure: fail, onSuccess: () => undefined })
        })
        socket.onError(fail)
        socket.onClose((code, reason) => {
          if (code !== 1000) fail(new Error(`OpenAI subscription WebSocket closed ${code}: ${reason}`))
        })
      }),
      catch: (cause) => transportFailure(request, cause),
    }),
  }),
).pipe(HttpClient.filterStatusOk)

/** The subscription client connecting directly, with no proxy. */
export const OpenAiCodexWebSocketHttpClient = makeOpenAiCodexWebSocketHttpClient(Option.none())
