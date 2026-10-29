import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { Socket } from "effect/socket"
import { Cache, Cause, Clock, Context, Duration, Effect, Exit, Match, Option, Predicate, Pull, Redacted, Result, Schema, Scope, Stream } from "effect"
import type { Array as Arr } from "effect"
import { release } from "node:os"
import WebSocket from "ws"
import type { WebSocketProxy } from "../ports/models-transport.port.js"
import { redactCredentials } from "../transport/http-proxy.entity.functions.js"
import { currentRuntime } from "../transport/models-transport.adapter.js"
import { OPENAI_CODEX_ORIGINATOR } from "../auth/openAiCodexOAuth.js"

const WEBSOCKET_BETA = "responses_websockets=2026-02-06"

/** How long the socket may take to open before the request fails as a transport error. */
const OPEN_TIMEOUT = Duration.seconds(30)

/** The conversations a client keeps a session id for; past it, the least recently used one gets a fresh id on its next request. */
export const OPENAI_CODEX_SESSION_CAPACITY = 1024

/** ChatGPT's Luna router currently keys its internal route on a
 * time-ordered UUIDv7 session id; UUIDv4 reaches a nonexistent rollout
 * alias. Keep one v7 id per Efferent conversation/cache key. `now` is the
 * id's time in epoch milliseconds (`Clock.currentTimeMillis`). */
export const openAiCodexUuidV7 = (now: number): string => {
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

/** The session id of each conversation (its prompt cache key) a client serves. */
export type OpenAiCodexSessions = Cache.Cache<string, string>

const mintSessionId: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, openAiCodexUuidV7)

/**
 * A session cache: a key's UUIDv7 is minted on its first request and kept
 * while it is used; past `capacity` keys the least recently used is dropped.
 */
export const makeOpenAiCodexSessions = (capacity = OPENAI_CODEX_SESSION_CAPACITY): Effect.Effect<OpenAiCodexSessions> =>
  Cache.make({ capacity, lookup: (_key: string) => mintSessionId })

/**
 * The session cache of the routed model a call runs under: each of the
 * models plugin's layers keeps its own, so two agents in one process never
 * share session ids. A subscription model built outside them keeps one of
 * its own.
 */
export const CurrentOpenAiCodexSessions = Context.Reference<Option.Option<OpenAiCodexSessions>>("@xandreed/plugin-models/CurrentOpenAiCodexSessions", {
  defaultValue: () => Option.none(),
})

/** A request's session id: its conversation's from `sessions`, a fresh one for a request without a cache key or without a cache. */
const sessionIdFor = (sessions: Option.Option<OpenAiCodexSessions>, cacheKey: Option.Option<string>): Effect.Effect<string> =>
  Option.match(Option.all([sessions, cacheKey]), {
    onNone: () => mintSessionId,
    onSome: ([cache, key]) => Cache.get(cache, key),
  })

const websocketUrl = (url: URL): string => {
  const next = new URL(url)
  next.protocol = next.protocol === "http:" ? "ws:" : "wss:"
  return next.toString()
}

/** A Responses request body, as the OpenAI client encodes it. */
const RequestBody = Schema.Record(Schema.String, Schema.Unknown)
const decodeRequestBody = Schema.decodeUnknownEffect(Schema.fromJsonString(RequestBody))
const decodeCacheKey = Schema.decodeUnknownOption(Schema.NonEmptyString)

/** One frame of the subscription stream: a JSON object naming its event `type`; its other fields are passed on as they are. */
const CodexFrame = Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [Schema.Record(Schema.String, Schema.Unknown)])
type CodexFrame = typeof CodexFrame.Type
const decodeFrame = Schema.decodeUnknownResult(Schema.fromJsonString(CodexFrame))

/** Codex currently names the WebSocket terminal event `response.done`; the
 * public Responses stream consumed by @effect/ai names it `response.completed`. */
export const normalizeOpenAiCodexWebSocketEvent = (value: unknown): unknown =>
  Predicate.isObject(value) && Predicate.hasProperty(value, "type") && value.type === "response.done"
    ? { ...value, type: "response.completed" }
    : value

const normalizeFrame = (frame: CodexFrame): CodexFrame =>
  frame.type === "response.done" ? { ...frame, type: "response.completed" } : frame

const TERMINAL_EVENTS: ReadonlySet<string> = new Set(["response.completed", "response.incomplete", "response.failed"])

export const isOpenAiCodexControlEvent = (type: unknown): boolean =>
  typeof type === "string" && (type.startsWith("codex.") || type === "responsesapi.websocket_timing")

/** The OpenAI error object of an `error` frame. */
const ErrorDetail = Schema.Struct({
  message: Schema.optionalKey(Schema.NullOr(Schema.String)),
  type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  param: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
type ErrorDetail = typeof ErrorDetail.Type
const decodeErrorDetail = Schema.decodeUnknownOption(ErrorDetail)
const noDetail: ErrorDetail = {}
const ErrorFrame = Schema.Struct({
  type: Schema.Literal("error"),
  status: Schema.optionalKey(Schema.Number),
  error: Schema.optionalKey(Schema.Unknown),
})
const decodeErrorFrame = Schema.decodeUnknownOption(ErrorFrame)

/** The OpenAI error body the HTTP Responses endpoint answers a failed request with. */
export interface OpenAiErrorBody {
  readonly error: {
    readonly message: string
    readonly type: string | null
    readonly code: string | null
    readonly param: string | null
  }
}

/** What an `error` frame says, as the HTTP endpoint would answer: a status, its OpenAI error body, and whether the request itself was refused. */
interface ErrorAnswer {
  readonly status: number
  readonly body: OpenAiErrorBody
  readonly refused: boolean
}

/** The status of an error type or code, as the OpenAI WebSocket mode reads one without a status. */
const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  invalid_api_key_error: 401,
  insufficient_quota_error: 429,
  rate_limit_error: 429,
  service_unavailable_error: 503,
}

const statusOfName = (name: Option.Option<string>): Option.Option<number> =>
  Option.flatMap(name, (key) => Option.fromNullishOr(ERROR_STATUS[key]))

/**
 * An `error` frame as the HTTP endpoint answers it. The error is the frame's
 * `error` object, or the frame itself (the Responses stream's own `error`
 * event). It refuses the request (a 400) when the frame's status is 400, its
 * error's type or code is `invalid_request_error`, or its message names an
 * image; otherwise its status is the frame's, or the one its type or code
 * stands for, or 500. Any other frame: none.
 */
const errorAnswer = (event: unknown): Option.Option<ErrorAnswer> => Option.map(decodeErrorFrame(event), (frame) => {
  const detail = Option.getOrElse(Option.orElse(decodeErrorDetail(frame.error), () => decodeErrorDetail(event)), () => noDetail)
  const message = Option.getOrElse(Option.fromNullishOr(detail.message), () => "")
  const type = Option.filter(Option.fromNullishOr(detail.type), (value) => value !== "error")
  const code = Option.fromNullishOr(detail.code)
  const refused = frame.status === 400 || /image/i.test(message)
    || Option.contains(type, "invalid_request_error") || Option.contains(code, "invalid_request_error")
  const status = refused ? 400 : Option.getOrElse(
    Option.orElse(Option.filter(Option.fromNullishOr(frame.status), (value) => value >= 400 && value < 600), () => Option.orElse(statusOfName(code), () => statusOfName(type))),
    () => 500,
  )
  return {
    status,
    refused,
    body: { error: {
      message: message.length > 0 ? message : refused ? "the request was refused" : "the subscription request failed",
      type: Option.getOrElse(type, () => refused ? "invalid_request_error" : null),
      code: Option.getOrNull(code),
      param: Option.getOrNull(Option.fromNullishOr(detail.param)),
    } },
  }
})

/**
 * The OpenAI error body of an `error` frame that refuses the request, which
 * the HTTP Responses endpoint would answer with a 400: the frame's status is
 * 400, its error's type or code is `invalid_request_error`, or its message
 * names an image. The error is the frame's `error` object, or the frame
 * itself (the Responses stream's own `error` event). Any other frame: none.
 */
export const openAiCodexRefusal = (event: unknown): Option.Option<OpenAiErrorBody> =>
  Option.map(Option.filter(errorAnswer(event), (answer) => answer.refused), (answer) => answer.body)

/**
 * Bun's own WebSocket, which takes `headers` and a `proxy` in its options.
 * The DOM declaration of `WebSocket` (the one in force with the DOM library)
 * has no options argument, so the constructor is called through `Reflect`.
 */
const bunSocket = (url: string, options: { readonly headers: Record<string, string>; readonly proxy: string }): Socket.WebSocketLike => {
  const socket: globalThis.WebSocket = Reflect.construct(globalThis.WebSocket, [url, options])
  return socket
}

/** A socket of the `ws` client (on Bun, Bun's stand-in for it, which takes neither an agent nor a proxy). */
const wsSocket = (url: string, options: WebSocket.ClientOptions): Socket.WebSocketLike => {
  const socket: Socket.WebSocketLike = new WebSocket(url, options)
  return socket
}

/** Open the socket: directly, with a Node agent (one that tunnels to the proxy, or a plain one), or through Bun's `proxy` option. */
const openSocket = (url: string, headers: Record<string, string>, proxy: Option.Option<WebSocketProxy>): Socket.WebSocketLike =>
  Option.match(proxy, {
    onNone: () => wsSocket(url, { headers }),
    onSome: (route) => Match.value(route).pipe(
      Match.tag("Agent", ({ agent }) => wsSocket(url, { headers, agent })),
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

/** A request with its credentials redacted, as its failures and responses carry it. */
const redacted = (request: HttpClientRequest.HttpClientRequest) => request.pipe(
  HttpClientRequest.setHeader("authorization", "[redacted]"),
  HttpClientRequest.setHeader("chatgpt-account-id", "[redacted]"),
)

/** What a failure's cause says: an error's message, an error event's error or message (a failed handshake), anything else as text. */
const causeText = (cause: unknown): string =>
  cause instanceof Error ? cause.message
    : Predicate.hasProperty(cause, "error") && cause.error instanceof Error ? cause.error.message
    : Predicate.hasProperty(cause, "message") && Predicate.isString(cause.message) && cause.message.length > 0 ? cause.message
    : Predicate.isObject(cause) ? "the WebSocket handshake failed"
    : String(cause)

/** What a socket failure says: a close's code and reason, any other failure with its cause. */
const socketFailureText = (error: Socket.SocketError): string => Match.value(error.reason).pipe(
  Match.tag("SocketCloseError", (close) => `closed ${close.code}${close.closeReason === undefined || close.closeReason.length === 0 ? "" : `: ${close.closeReason}`}`),
  Match.tag("SocketUpgradeError", (upgrade) => upgrade.message),
  Match.orElse((reason) => reason._tag === "SocketOpenError" && reason.kind === "Timeout" ? reason.message : `${reason.message}: ${causeText(reason.cause)}`),
)

/** A failed subscription request, as the HTTP client reports it (credentials redacted). */
const transportFailure = (request: HttpClientRequest.HttpClientRequest, description: string, cause?: unknown) => new HttpClientError.HttpClientError({
  reason: new HttpClientError.TransportError({
    request: redacted(request),
    description: `OpenAI subscription WebSocket failed: ${redactCredentials(description)}`,
    cause,
  }),
})

/** The request's body, which is no JSON object. */
const encodeFailure = (request: HttpClientRequest.HttpClientRequest, error: Schema.SchemaError) => new HttpClientError.HttpClientError({
  reason: new HttpClientError.EncodeError({ request: redacted(request), description: `the subscription request body is not a JSON object: ${error.message}`, cause: error }),
})

/**
 * The headers the socket opens with: the request's credentials and
 * originator, then the subscription's own. A WebSocket upgrade has a
 * deliberately smaller header contract than the HTTP request: forwarding
 * content-length or HTTP tracing headers makes the Codex upgrade terminate
 * silently.
 */
const socketHeaders = (request: HttpClientRequest.HttpClientRequest, sessionId: string): Record<string, string> => ({
  ...Object.fromEntries(["authorization", "chatgpt-account-id", "originator"].flatMap((key) =>
    Option.toArray(Option.map(Option.fromNullishOr(request.headers[key]), (value) => [key, value] as const)))),
  "openai-beta": WEBSOCKET_BETA,
  "user-agent": `${OPENAI_CODEX_ORIGINATOR} (${process.platform} ${release()}; ${process.arch})`,
  "session-id": sessionId,
  "x-client-request-id": sessionId,
})

/** A pulled frame: decoded, or why it does not decode (which fails the stream once it is read). */
type Frame = Result.Result<CodexFrame, Schema.SchemaError>

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/** A socket close the server meant: code 1000, which ends the stream. */
const isNormalClose = (error: Socket.SocketError): boolean =>
  error.reason._tag === "SocketCloseError" && error.reason.code === 1000

/**
 * The frames of an exchange: each decoded, the control frames dropped (the
 * subscription's own, consumed out of band: the OpenAI decoder sees only the
 * Responses stream's vocabulary), `response.done` renamed; the stream ends
 * after a terminal event, or when the server closes the socket normally.
 */
const framesOf = (pull: Socket.Reader["pull"]): Stream.Stream<Frame, Socket.SocketError> => {
  const next: Pull.Pull<Arr.NonEmptyReadonlyArray<Uint8Array | string>, Socket.SocketError> = Effect.catch(
    pull,
    (error): Effect.Effect<never, Socket.SocketError | Cause.Done> => isNormalClose(error) ? Cause.done() : Effect.fail(error),
  )
  return Stream.fromPull(Effect.succeed(next)).pipe(
    Stream.map((data) => Result.map(decodeFrame(typeof data === "string" ? data : decoder.decode(data)), normalizeFrame)),
    Stream.filter((frame) => Result.isFailure(frame) || !isOpenAiCodexControlEvent(frame.success.type)),
    Stream.takeUntil((frame) => Result.isSuccess(frame) && TERMINAL_EVENTS.has(frame.success.type)),
  )
}

/**
 * A frame as the SSE body carries it: an event as its `data:` line. A frame
 * that does not decode, or an `error` event after the stream began, fails
 * the body, and the OpenAI client reports the stream as undecodable.
 */
const sseBytes = (request: HttpClientRequest.HttpClientRequest) => (frame: Frame): Effect.Effect<Uint8Array, HttpClientError.HttpClientError> =>
  Result.match(frame, {
    onFailure: (error) => Effect.fail(transportFailure(request, `a frame is not a JSON event object: ${error.message}`, error)),
    onSuccess: (event) => event.type === "error"
      ? Effect.fail(transportFailure(request, `the stream carried an error: ${JSON.stringify(event).slice(0, 500)}`))
      : Effect.succeed(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
  })

/**
 * One exchange over its own socket, opened in `scope`: send the request,
 * read up to the first event, and answer as the HTTP endpoint would. An
 * `error` event first is answered with its status and OpenAI error body
 * (`errorAnswer`); any other is the start of a 200 event stream, which
 * closes `scope` when it ends, fails or is cancelled. A failure before the
 * first event (the socket does not open, or closes) fails the request.
 */
const exchange = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
  proxy: Option.Option<WebSocketProxy>,
  sessions: Option.Option<OpenAiCodexSessions>,
  scope: Scope.Closeable,
): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => Effect.gen(function* () {
  const encoded: Effect.Effect<typeof RequestBody.Type, Schema.SchemaError> = request.body._tag === "Uint8Array"
    ? decodeRequestBody(decoder.decode(request.body.body))
    : Effect.succeed({})
  const body = yield* Effect.mapError(encoded, (error) => encodeFailure(request, error))
  const sessionId = yield* sessionIdFor(sessions, decodeCacheKey(body["prompt_cache_key"]))
  const headers = socketHeaders(request, sessionId)
  const socket = yield* Socket.fromWebSocket(
    Effect.acquireRelease(
      Effect.try({
        try: () => openSocket(websocketUrl(url), headers, proxy),
        catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
      }),
      (ws) => Effect.sync(() => ws.close(1000, "done")),
    ),
    { openTimeout: OPEN_TIMEOUT },
  )
  const socketFailure = (error: Socket.SocketError) => transportFailure(request, socketFailureText(error), error)
  const { pull } = yield* Scope.provide(socket.reader, scope).pipe(Effect.mapError(socketFailure))
  const writer = yield* Scope.provide(socket.writer, scope)
  yield* writer.write(JSON.stringify({ type: "response.create", ...body, prompt_cache_key: sessionId })).pipe(Effect.mapError(socketFailure))
  const events = yield* Scope.provide(Stream.toPull(framesOf(pull)), scope)
  const first = yield* events.pipe(
    Effect.mapError((error) => Cause.isDone(error) ? error : socketFailure(error)),
    Pull.catchDone(() => Effect.fail(transportFailure(request, "the socket closed before the first event"))),
  )
  const head = first[0]
  const safeRequest = redacted(request)
  return yield* Option.match(Option.flatMap(Result.getSuccess(head), errorAnswer), {
    onSome: (answer) => Scope.close(scope, Exit.void).pipe(Effect.as(HttpClientResponse.fromWeb(safeRequest, new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    })))),
    onNone: () => Stream.fromIterable(first).pipe(
      Stream.concat(Stream.fromPull(Effect.succeed(events))),
      Stream.mapError(socketFailure),
      Stream.mapEffect(sseBytes(request)),
      Stream.tapError((error) => Effect.logWarning(error.message)),
      Stream.ensuring(Scope.close(scope, Exit.void)),
      Stream.toReadableStreamEffect(),
      Effect.map((stream) => HttpClientResponse.fromWeb(safeRequest, new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }))),
    ),
  })
})

/** Adapt the ChatGPT Codex WebSocket protocol to an SSE-shaped HttpClient
 * response. OpenAiLanguageModel remains the sole protocol decoder, so text,
 * reasoning, tool calls, tool results, usage, and errors keep their standard
 * Effect representations instead of being reimplemented here. `proxy` is how
 * the socket reaches ChatGPT (`ModelsTransport.webSocketAgent`); `None`
 * connects directly. A route this runtime cannot use fails every request.
 * `sessions` keeps each conversation's session id (`makeOpenAiCodexSessions`);
 * without it, every request gets a fresh one.
 *
 * Each request opens its own socket (Effect's `Socket`), which closes when
 * the response's stream ends, fails or is cancelled, when the request is
 * aborted, and when the request fails before its first event. The response
 * is the stream once the first event arrives, unless that event is an
 * `error`: the request then fails with the status and the OpenAI error body
 * the HTTP endpoint would answer, so a refused image (`openAiCodexRefusal`)
 * is an `InvalidRequestError` and an exhausted quota a
 * `QuotaExhaustedError`. The stream ends after a terminal event or when the
 * server closes the socket normally; a close before the first event fails
 * the request as a transport error. */
export const makeOpenAiCodexWebSocketHttpClient = (
  proxy: Option.Option<WebSocketProxy>,
  sessions: Option.Option<OpenAiCodexSessions> = Option.none(),
) => HttpClient.make(
  (request, url, signal) => Option.match(Option.flatMap(proxy, routeMismatch), {
    onSome: (why) => Effect.fail(transportFailure(request, why)),
    onNone: () => Effect.gen(function* () {
      const scope = yield* Scope.make()
      const close = Scope.close(scope, Exit.void)
      const run = Effect.runForkWith(yield* Effect.context<never>())
      const abort = () => {
        run(close)
      }
      signal.addEventListener("abort", abort, { once: true })
      yield* Scope.addFinalizer(scope, Effect.sync(() => signal.removeEventListener("abort", abort)))
      return yield* exchange(request, url, proxy, sessions, scope).pipe(
        Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.void : close),
      )
    }),
  }),
).pipe(HttpClient.filterStatusOk)

/** The subscription client connecting directly, with no proxy (a fresh session id per request). */
export const OpenAiCodexWebSocketHttpClient = makeOpenAiCodexWebSocketHttpClient(Option.none())
