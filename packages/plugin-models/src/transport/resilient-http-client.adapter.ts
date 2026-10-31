import { Clock, Duration, Effect, Inspectable, Match, Option, Random, Ref, Schema, Stream } from "effect"
import { AiError } from "effect/ai"
import { HttpClient, HttpClientError, HttpClientResponse, UrlParams } from "effect/http"
import type { HttpClientRequest } from "effect/http"
import { modelFailureMessageOf, modelFailureOf, stampAiErrorFailure } from "@xandreed/core"
import type { ModelFailureKind } from "@xandreed/core"
import { ModelRequestState, ModelRetryPolicy } from "../llm/model-retry-policy.entity.js"
import { enterFallbackState, retryableModelFailure, retryDelayMillis, startAttemptState } from "../llm/model-retry-policy.entity.functions.js"
import { CurrentModelRequestCall, CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import { ProviderErrorBody } from "../llm/provider-failure.entity.js"
import type { ProviderFailureProtocol } from "../llm/provider-failure.entity.js"
import { classifyAiError } from "../llm/provider-failure.entity.functions.js"
import { classifyLlmError } from "../llm/retry.js"

export type ResilientHttpError = HttpClientError.HttpClientError | AiError.AiError
type BodyReaders = "json" | "text" | "arrayBuffer" | "urlParamsBody" | "formData" | "stream"
/** Exact body-reader error channels before the existing SDK-boundary adaptation. */
export type ResilientHttpResponse = Omit<HttpClientResponse.HttpClientResponse, BodyReaders> & {
  readonly json: Effect.Effect<Schema.Json, ResilientHttpError>
  readonly text: Effect.Effect<string, ResilientHttpError>
  readonly arrayBuffer: Effect.Effect<ArrayBuffer, ResilientHttpError>
  readonly urlParamsBody: Effect.Effect<UrlParams.UrlParams, ResilientHttpError>
  readonly formData: Effect.Effect<FormData, ResilientHttpError>
  readonly stream: Stream.Stream<Uint8Array, ResilientHttpError>
  readonly modelAttempt: { readonly call: ModelRequestCall; readonly ordinal: number }
}

/** One call's ephemeral identity and observable physical-attempt state; no stored ledger. */
export interface ModelRequestCall {
  readonly policy: ModelRetryPolicy
  readonly startedAt: number
  readonly deadline: number
  readonly reserveFallback: boolean
  readonly state: Ref.Ref<ModelRequestState>
}

const timeoutFailure = () => stampAiErrorFailure(AiError.make({ module: "Models", method: "request", reason: new AiError.UnknownError({ description: modelFailureMessageOf("Timeout") }) }), "Timeout")

export const makeModelRequestCall = Effect.fnUntraced(function* (options: { readonly reserveFallback: boolean }): Effect.fn.Return<ModelRequestCall, AiError.AiError> {
  const policy = yield* Schema.decodeUnknownEffect(ModelRetryPolicy)(yield* CurrentModelRetryPolicy, { onExcessProperty: "error" }).pipe(Effect.mapError(() => stampAiErrorFailure(AiError.make({ module: "Models", method: "requestPolicy", reason: new AiError.InvalidRequestError({ description: modelFailureMessageOf("InvalidRequest") }) }), "InvalidRequest")))
  const startedAt = yield* Clock.currentTimeMillis
  const state = yield* Ref.make<ModelRequestState>({ _tag: "Ready", rung: "Primary", attempts: 0 })
  return { policy, startedAt, deadline: startedAt + policy.totalTimeoutMs, reserveFallback: options.reserveFallback, state }
})

export const modelRequestSnapshot = (call: ModelRequestCall): Effect.Effect<ModelRequestState> => Ref.get(call.state)

export const enterModelFallback = Effect.fnUntraced(function* (call: ModelRequestCall, error: unknown): Effect.fn.Return<boolean> {
  const now = yield* Clock.currentTimeMillis
  if (now >= call.deadline || classifyLlmError(error, now) !== "transient") return false
  return yield* Ref.modify(call.state, (state) => Option.match(enterFallbackState(state, call.policy, call.reserveFallback), {
    onNone: () => [false, state] as const,
    onSome: (next) => [true, next] as const,
  }))
})

const pendingRead = <A, E, R>(effect: Effect.Effect<A, E, R>, call: ModelRequestCall, idleMs: number): Effect.Effect<A, E | AiError.AiError, R> => Effect.flatMap(Clock.currentTimeMillis, (now) => now >= call.deadline
  ? Effect.fail(timeoutFailure())
  : effect.pipe(Effect.timeoutOrElse({ duration: Duration.millis(Math.min(idleMs, call.deadline - now)), orElse: () => Effect.fail(timeoutFailure()) })),
)

const guardedBody = (response: HttpClientResponse.HttpClientResponse, call: ModelRequestCall): Stream.Stream<Uint8Array, ResilientHttpError> =>
  Stream.transformPull(response.stream, (pull) => Effect.succeed(pendingRead(pull, call, call.policy.bodyIdleTimeoutMs)))

const concatenate = (pieces: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> => {
  const bytes = new Uint8Array(pieces.reduce((size, piece) => size + piece.byteLength, 0))
  pieces.reduce((offset, piece) => { bytes.set(piece, offset); return offset + piece.byteLength }, 0)
  return bytes
}

/** Forward metadata/getters; all body readers share the same guarded byte materialization. */
class GuardedResponse implements ResilientHttpResponse {
  readonly [HttpClientResponse.TypeId] = HttpClientResponse.TypeId
  readonly ["~effect/http/HttpIncomingMessage"] = "~effect/http/HttpIncomingMessage"
  readonly #original: HttpClientResponse.HttpClientResponse
  constructor(
    original: HttpClientResponse.HttpClientResponse,
    readonly stream: Stream.Stream<Uint8Array, ResilientHttpError>,
    readonly buffered: Effect.Effect<Uint8Array<ArrayBuffer>, ResilientHttpError>,
    readonly modelAttempt: { readonly call: ModelRequestCall; readonly ordinal: number },
  ) { this.#original = original }
  get request() { return this.#original.request }
  get url() { return this.#original.url }
  get status() { return this.#original.status }
  get headers() { return this.#original.headers }
  get cookies() { return this.#original.cookies }
  get remoteAddress() { return this.#original.remoteAddress }
  get upgrade() { return this.#original.upgrade }
  get pipe() { return this.#original.pipe }
  get arrayBuffer() { return Effect.map(this.buffered, (bytes) => bytes.buffer) }
  get text() { return Effect.map(this.buffered, (bytes) => new TextDecoder().decode(bytes)) }
  get json() { return this.text.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))), Effect.mapError((cause) => AiError.isAiError(cause) || HttpClientError.isHttpClientError(cause) ? cause : this.decodeFailure(cause))) }
  get urlParamsBody() { return Effect.map(this.text, (text) => UrlParams.fromInput(new URLSearchParams(text))) }
  get formData() { return this.buffered.pipe(Effect.flatMap((bytes) => Effect.tryPromise({ try: () => new Response(bytes, { headers: this.headers }).formData(), catch: (cause) => this.decodeFailure(cause) }))) }
  private decodeFailure(cause: unknown) { return new HttpClientError.HttpClientError({ reason: new HttpClientError.DecodeError({ request: this.request, response: this.#original, cause, description: modelFailureMessageOf("InvalidResponse") }) }) }
  toJSON() { return this.#original.toJSON() }
  toString() { return this.#original.toString() }
  [Inspectable.NodeInspectSymbol]() { return this.toJSON() }
}

const wrapResponse = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse, call: ModelRequestCall, ordinal: number) {
  const stream = guardedBody(response, call)
  const buffered = yield* Effect.cached(Stream.runCollect(stream).pipe(Effect.map(concatenate)))
  return new GuardedResponse(response, stream, buffered, { call, ordinal })
})

const httpDetails = (response: HttpClientResponse.HttpClientResponse, body: string): typeof AiError.HttpContext.Type => {
  const url = URL.canParse(response.request.url) ? new URL(response.request.url) : new URL("https://provider.invalid/")
  return { request: { method: response.request.method, url: `${url.protocol}//${url.host}${url.pathname}`, urlParams: [], headers: {} }, response: { status: response.status, headers: Object.fromEntries(Object.entries(response.headers).filter(([key]) => ["request-id", "x-request-id", "retry-after"].includes(key))) }, body }
}

const responseFailure = (response: HttpClientResponse.HttpClientResponse, text: string, protocol: ProviderFailureProtocol): AiError.AiError => {
  const http = httpDetails(response, text)
  const classified = classifyAiError(AiError.make({ module: "Models", method: "request", reason: new AiError.UnknownError({ http }) }), protocol)
  const kind = Option.getOrElse(modelFailureOf(classified), (): ModelFailureKind => "Unknown")
  const diagnostic = Option.flatMap(Schema.decodeUnknownOption(Schema.fromJsonString(ProviderErrorBody))(text), (body) => Option.fromNullishOr([
    typeof body.error === "string" ? body.error : body.error?.message, body.message,
  ].find((value): value is string => typeof value === "string" && value.trim().length > 0)))
  const common = { http, description: Option.match(diagnostic, { onNone: () => modelFailureMessageOf(kind), onSome: (message) => message.slice(0, 500) }) }
  const reason = Match.value(kind).pipe(
    Match.when("Authentication", () => new AiError.AuthenticationError({ ...common, kind: response.status === 403 ? "InsufficientPermissions" : "InvalidKey" })),
    Match.when("Quota", () => new AiError.QuotaExhaustedError(common)),
    Match.when("RateLimit", () => new AiError.RateLimitError(common)),
    Match.when("InvalidRequest", () => new AiError.InvalidRequestError(common)),
    Match.when("ContextOverflow", () => new AiError.InvalidRequestError(common)),
    Match.when("InvalidResponse", () => new AiError.InvalidResponseError(common)),
    Match.when("Transient", () => new AiError.InternalProviderError(common)),
    Match.orElse(() => new AiError.UnknownError(common)),
  )
  return stampAiErrorFailure(AiError.make({ module: "Models", method: "request", reason }), kind)
}

const errorBody = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse, call: ModelRequestCall): Effect.fn.Return<string, ResilientHttpError> {
  const bytes = new Uint8Array(65536)
  const retained = yield* Ref.make(0)
  const size = yield* Stream.runFoldEffect(guardedBody(response, call), () => 0, (size, piece) => {
    const keep = Math.min(piece.byteLength, bytes.byteLength - size)
    bytes.set(piece.subarray(0, keep), size)
    return size + piece.byteLength > bytes.byteLength
      ? Effect.fail(stampAiErrorFailure(AiError.make({ module: "Models", method: "request", reason: new AiError.InvalidResponseError({ description: modelFailureMessageOf("InvalidResponse"), http: httpDetails(response, new TextDecoder().decode(bytes)) }) }), "InvalidResponse"))
      : Ref.set(retained, size + piece.byteLength).pipe(Effect.as(size + piece.byteLength))
  }).pipe(Effect.catchTag("HttpClientError", (error) =>
    // These are byte-read failures on an already rejected response, before
    // SDK/JSON decoding. Known status and any retained evidence still apply.
    ["DecodeError", "EmptyBodyError", "TransportError"].includes(error.reason._tag)
      ? Ref.get(retained) : Effect.fail(error),
  ))
  return new TextDecoder().decode(bytes.subarray(0, size))
})

const errorKind = (error: ResilientHttpError): ModelFailureKind => HttpClientError.isHttpClientError(error) ? Match.valueTags(error.reason, {
  TransportError: () => "Transient" as const,
  EncodeError: () => "InvalidRequest" as const,
  InvalidUrlError: () => "InvalidRequest" as const,
  StatusCodeError: () => "Unknown" as const,
  DecodeError: () => "InvalidResponse" as const,
  EmptyBodyError: () => "InvalidResponse" as const,
}) : Option.getOrElse(modelFailureOf(error), (): ModelFailureKind => "Unknown")

const replayableBody = (request: HttpClientRequest.HttpClientRequest): boolean => Match.valueTags(request.body, {
  Empty: () => true, Uint8Array: () => true, Stream: () => false, FormData: () => false,
  Raw: (body) => typeof body.body === "string" || body.body instanceof ArrayBuffer || ArrayBuffer.isView(body.body),
})

const awaitReady = Effect.fnUntraced(function* (call: ModelRequestCall): Effect.fn.Return<void, AiError.AiError> {
  const now = yield* Clock.currentTimeMillis
  if (now >= call.deadline) return yield* Effect.fail(timeoutFailure())
  const state = yield* Ref.get(call.state)
  const readyAt = ModelRequestState.match(state, { Ready: (value) => value.readyAt ?? now, Rejected: (value) => value.retryAt ?? now, Sending: () => now, Committed: () => now })
  if (readyAt > now) yield* Effect.sleep(Duration.millis(Math.min(readyAt - now, call.deadline - now)))
  if ((yield* Clock.currentTimeMillis) >= call.deadline) return yield* Effect.fail(timeoutFailure())
})

/** A committed inherited call belongs to an outer SDK consumer; a new child HTTP operation is independent. */
const requestCall = Effect.fnUntraced(function* (): Effect.fn.Return<ModelRequestCall, AiError.AiError> {
  const inherited = yield* CurrentModelRequestCall
  if (Option.isSome(inherited) && (yield* Ref.get(inherited.value.state))._tag !== "Committed") return inherited.value
  return yield* makeModelRequestCall({ reserveFallback: false })
})

/** One retry owner before response handoff; successful response readers retain exact typed failures. */
export const resilientRequest = Effect.fn("models.request")(function* <R>(client: HttpClient.HttpClient.With<HttpClientError.HttpClientError, R>, request: HttpClientRequest.HttpClientRequest, options: { readonly protocol: ProviderFailureProtocol }): Effect.fn.Return<ResilientHttpResponse, ResilientHttpError, R> {
  const call = yield* requestCall()
  const replayable = replayableBody(request)
  const run = (previous: Option.Option<ResilientHttpError>): Effect.Effect<ResilientHttpResponse, ResilientHttpError, R> => Effect.gen(function* () {
    yield* awaitReady(call)
    const started = yield* Ref.modify(call.state, (state) => Option.match(startAttemptState(state, call.policy, call.reserveFallback), { onNone: () => [Option.none<number>(), state] as const, onSome: (next) => [Option.some(next.attempts), next] as const }))
    if (Option.isNone(started)) return yield* Option.match(previous, { onNone: () => Effect.fail(stampAiErrorFailure(AiError.make({ module: "Models", method: "request", reason: new AiError.InvalidRequestError({ description: modelFailureMessageOf("InvalidRequest") }) }), "InvalidRequest")), onSome: Effect.fail })
    const ordinal = started.value
    const execute = client.execute(request).pipe(Effect.provideService(CurrentModelRequestCall, Option.some(call)), Effect.catchTag("HttpClientError", (error) => error.reason._tag === "StatusCodeError" ? Effect.succeed(error.reason.response) : Effect.fail(error)))
    const result = yield* Effect.result(pendingRead(execute, call, call.policy.requestTimeoutMs).pipe(Effect.flatMap((response): Effect.Effect<ResilientHttpResponse, ResilientHttpError> => response.status >= 200 && response.status < 300
      ? Ref.update(call.state, (state): ModelRequestState => state._tag === "Sending" && state.attempts === ordinal ? { _tag: "Committed", rung: state.rung, attempts: ordinal } : state).pipe(Effect.andThen(wrapResponse(response, call, ordinal)))
      : errorBody(response, call).pipe(Effect.flatMap((body) => Effect.fail(responseFailure(response, body, options.protocol)))),
    )))
    if (result._tag === "Success") return result.success
    const failure = result.failure
    const kind = errorKind(failure)
    const now = yield* Clock.currentTimeMillis
    const hint = AiError.isAiError(failure) && "http" in failure.reason ? Option.fromNullishOr(failure.reason.http?.response?.headers["retry-after"]) : Option.none()
    const serverHint = Option.filter(hint, (value): value is string => typeof value === "string")
    const delay = retryDelayMillis(call.policy, ordinal, yield* Random.next, serverHint, now)
    yield* Ref.update(call.state, (state): ModelRequestState => state._tag === "Sending" && state.attempts === ordinal ? { _tag: "Rejected", rung: state.rung, attempts: ordinal, kind, replayable, ...(retryableModelFailure(kind) && replayable ? { retryAt: now + delay } : {}) } : state)
    const state = yield* Ref.get(call.state)
    return Option.isSome(startAttemptState(state, call.policy, call.reserveFallback)) ? yield* run(Option.some(failure)) : yield* Effect.fail(failure)
  })
  return yield* run(Option.none())
})

export const resilientHttpClient = <R>(client: HttpClient.HttpClient.With<HttpClientError.HttpClientError, R>, options: { readonly protocol: ProviderFailureProtocol; readonly adaptResponse: (response: ResilientHttpResponse) => HttpClientResponse.HttpClientResponse }): HttpClient.HttpClient.With<ResilientHttpError, R> => HttpClient.makeWith(
  (prepared) => Effect.flatMap(prepared, (request) => resilientRequest(HttpClient.makeWith(client.postprocess, Effect.succeed), request, options).pipe(Effect.map(options.adaptResponse))),
  client.preprocess,
)
