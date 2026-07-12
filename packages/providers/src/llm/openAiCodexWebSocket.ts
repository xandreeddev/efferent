import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform"
import { Effect, Either } from "effect"
import { release } from "node:os"
import WebSocket from "ws"

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

/** ChatGPT's Luna router currently keys its internal route on Pi's
 * time-ordered UUIDv7 session shape; UUIDv4 reaches a nonexistent rollout
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

/** Adapt the ChatGPT Codex WebSocket protocol to an SSE-shaped HttpClient
 * response. OpenAiLanguageModel remains the sole protocol decoder, so text,
 * reasoning, tool calls, tool results, usage, and errors keep their standard
 * Effect representations instead of being reimplemented here. */
export const OpenAiCodexWebSocketHttpClient = HttpClient.make(
  (request, url, signal) =>
    Effect.tryPromise({
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
        headers["user-agent"] = `pi (${process.platform} ${release()}; ${process.arch})`
        const requestId = sessionIdFor(body["prompt_cache_key"])
        body["prompt_cache_key"] = requestId
        headers["session-id"] = requestId
        headers["x-client-request-id"] = requestId

        const socket = new WebSocket(websocketUrl(url), { headers })
        const state: {
          settled: boolean
          controller?: ReadableStreamDefaultController<Uint8Array>
        } = { settled: false }
        const stream = new ReadableStream<Uint8Array>({
          start: (value) => {
            state.controller = value
          },
          cancel: () => socket.close(1000, "cancelled"),
        })

        const fail = (cause: unknown) => {
          if (!state.settled) {
            state.settled = true
            reject(cause)
          } else {
            state.controller?.error(cause)
          }
          socket.close(1011, "transport error")
        }
        const abort = () => fail(new Error("OpenAI subscription request aborted"))
        signal.addEventListener("abort", abort, { once: true })

        socket.addEventListener("open", () => {
          Either.match(Either.try(() => {
            socket.send(JSON.stringify({ type: "response.create", ...body }))
            state.settled = true
            return (
              HttpClientResponse.fromWeb(
                safeRequest,
                new Response(stream, {
                  status: 200,
                  headers: { "content-type": "text/event-stream" },
                }),
              )
            )
          }), { onLeft: fail, onRight: resolve })
        })
        socket.addEventListener("message", (event) => {
          Either.match(Either.try(() => {
            const text = eventText(event.data)
            if (text === undefined) return
            const parsed = normalizeOpenAiCodexWebSocketEvent(JSON.parse(text)) as Json
            const type = parsed["type"]
            // Subscription-only control frames are not Responses API events.
            // Pi consumes these out-of-band; the Effect model decoder should
            // see only the standard response stream vocabulary.
            if (typeof type === "string" && type.startsWith("codex.")) return
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
          }), { onLeft: fail, onRight: () => undefined })
        })
        socket.addEventListener("error", (event) =>
          fail(event.error ?? new Error(event.message || "WebSocket handshake failed")),
        )
        socket.addEventListener("close", (event) => {
          if (event.code !== 1000) fail(new Error(`OpenAI subscription WebSocket closed ${event.code}: ${event.reason}`))
        })
      }),
      catch: (cause) => new HttpClientError.RequestError({
        request: request.pipe(
          HttpClientRequest.setHeader("authorization", "[redacted]"),
          HttpClientRequest.setHeader("chatgpt-account-id", "[redacted]"),
        ),
        reason: "Transport",
        description: `OpenAI subscription WebSocket failed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        cause,
      }),
    }),
)
