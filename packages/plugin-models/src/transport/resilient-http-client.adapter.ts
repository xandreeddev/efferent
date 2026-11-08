import { Clock, Duration, Effect, Exit, Inspectable, Match, Option, Random, Ref, Schema, Stream } from "effect"
import { AiError } from "effect/ai"
import { HttpClient, HttpClientError, HttpClientResponse, UrlParams } from "effect/http"
import type { HttpClientRequest } from "effect/http"
import { isTurnError, modelFailureMessageOf, modelFailureOf, stampAiErrorFailure } from "@xandreed/core"
import type { ModelCallMethod, ModelFailureKind, ModelSelection, TurnError } from "@xandreed/core"
import { ModelRequestState, ModelRetryPolicy } from "../llm/model-retry-policy.entity.js"
import { enterFallbackState, retryableModelFailure, retryDelayMillis, retryHintMillis, startAttemptState } from "../llm/model-retry-policy.entity.functions.js"
import { CurrentModelRequestCall, CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import { ProviderErrorBody } from "../llm/provider-failure.entity.js"
import type { ProviderFailureProtocol } from "../llm/provider-failure.entity.js"
import { classifyAiError } from "../llm/provider-failure.entity.functions.js"
import { classifyLlmError } from "../llm/retry.js"
import { reserveSend } from "../llm/model-spend-guard.adapter.js"
import { neverConnected, reachOfStatus } from "../llm/model-spend.entity.functions.js"
import { attachModelAttempt, beginModelAttempt, completeModelAttempt, completePendingAttempts, makeCompletionCall, observeModelBody, retainModelAttempt } from "../llm/model-completion.adapter.js"
import type { ModelAttempt, ModelCompletionCall } from "../llm/model-completion.adapter.js"
import { CurrentModelCallMetadataOwner, CurrentModelCallMethod, CurrentModelCallSelection } from "../ports/model-call-completion.port.js"

export type ResilientHttpError = HttpClientError.HttpClientError | AiError.AiError | TurnError
type BodyReaders = "json" | "text" | "arrayBuffer" | "urlParamsBody" | "formData" | "stream"
/** Exact body-reader error channels before the existing SDK-boundary adaptation. */
export type ResilientHttpResponse = Omit<HttpClientResponse.HttpClientResponse, BodyReaders> & {
  readonly json: Effect.Effect<Schema.Json, ResilientHttpError>
  readonly text: Effect.Effect<string, ResilientHttpError>
  readonly arrayBuffer: Effect.Effect<ArrayBuffer, ResilientHttpError>
  readonly urlParamsBody: Effect.Effect<UrlParams.UrlParams, ResilientHttpError>
  readonly formData: Effect.Effect<FormData, ResilientHttpError>
  readonly stream: Stream.Stream<Uint8Array, ResilientHttpError>
  readonly modelAttempt: { readonly call: ModelRequestCall; readonly ordinal: number; readonly completion: ModelAttempt }
}

/** One call's ephemeral identity and observable physical-attempt state; no stored ledger. */
export interface ModelRequestCall {
  readonly policy: ModelRetryPolicy
  readonly completion: ModelCompletionCall
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
  return { policy, completion: yield* makeCompletionCall(), startedAt, deadline: startedAt + policy.totalTimeoutMs, reserveFallback: options.reserveFallback, state }
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

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>, boundMs: number): Effect.Effect<A, E | AiError.AiError, R> =>
  effect.pipe(Effect.timeoutOrElse({ duration: Duration.millis(boundMs), orElse: () => Effect.fail(timeoutFailure()) }))

/** A wait before handoff: its own bound, within the logical call's remaining deadline. */
const pendingRead = <A, E, R>(effect: Effect.Effect<A, E, R>, call: ModelRequestCall, boundMs: number): Effect.Effect<A, E | AiError.AiError, R> => Effect.flatMap(Clock.currentTimeMillis, (now) => now >= call.deadline
  ? Effect.fail(timeoutFailure())
  : timed(effect, Math.min(boundMs, call.deadline - now)),
)

/** A rejected response's body, read before another send: each pending read within the call's deadline. */
const rejectedBody = (response: HttpClientResponse.HttpClientResponse, call: ModelRequestCall): Stream.Stream<Uint8Array, ResilientHttpError> =>
  Stream.transformPull(response.stream, (pull) => Effect.succeed(pendingRead(pull, call, call.policy.bodyIdleTimeoutMs)))

/** The request a failure names: method and URL without its query, no headers. */
const requestDetails = (request: HttpClientRequest.HttpClientRequest): typeof AiError.HttpRequestDetails.Type => {
  const url = URL.canParse(request.url) ? new URL(request.url) : new URL("https://provider.invalid/")
  return { method: request.method, url: `${url.protocol}//${url.host}${url.pathname}`, urlParams: [], headers: {} }
}

/** A handed-off body that cannot be read further lost its connection: a transient network failure, never the provider's answer. */
const bodyReadFailure = (response: HttpClientResponse.HttpClientResponse): AiError.AiError =>
  AiError.make({ module: "Models", method: "request", reason: new AiError.NetworkError({ reason: "TransportError", request: requestDetails(response.request), description: modelFailureMessageOf("Transient") }) })

/**
 * A handed-off body: each pending read has its idle bound only, so a
 * response that keeps arriving can outlast the call's deadline, and a read
 * that fails is a transient network failure (`bodyReadFailure`).
 */
const committedBody = (response: HttpClientResponse.HttpClientResponse, call: ModelRequestCall): Stream.Stream<Uint8Array, ResilientHttpError> =>
  Stream.transformPull(response.stream, (pull) => Effect.succeed(timed(pull, call.policy.bodyIdleTimeoutMs))).pipe(
    Stream.mapError((error): ResilientHttpError => HttpClientError.isHttpClientError(error) && error.reason._tag === "DecodeError" ? bodyReadFailure(response) : error),
  )

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
    readonly modelAttempt: { readonly call: ModelRequestCall; readonly ordinal: number; readonly completion: ModelAttempt },
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
  get json() { return this.text.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))), Effect.mapError((cause) => AiError.isAiError(cause) || HttpClientError.isHttpClientError(cause) || isTurnError(cause) ? cause : this.decodeFailure(cause))) }
  get urlParamsBody() { return Effect.map(this.text, (text) => UrlParams.fromInput(new URLSearchParams(text))) }
  get formData() { return this.buffered.pipe(Effect.flatMap((bytes) => Effect.tryPromise({ try: () => new Response(bytes, { headers: this.headers }).formData(), catch: (cause) => this.decodeFailure(cause) }))) }
  private decodeFailure(cause: unknown) { return new HttpClientError.HttpClientError({ reason: new HttpClientError.DecodeError({ request: this.request, response: this.#original, cause, description: modelFailureMessageOf("InvalidResponse") }) }) }
  toJSON() { return this.#original.toJSON() }
  toString() { return this.#original.toString() }
  [Inspectable.NodeInspectSymbol]() { return this.toJSON() }
}

const guardedResponse = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse, stream: Stream.Stream<Uint8Array, ResilientHttpError>, modelAttempt: GuardedResponse["modelAttempt"]) {
  const buffered = yield* Effect.cached(Stream.runCollect(stream).pipe(Effect.map(concatenate)))
  return attachModelAttempt(modelAttempt.completion, new GuardedResponse(response, stream, buffered, modelAttempt))
})

const wrapResponse = (response: HttpClientResponse.HttpClientResponse, call: ModelRequestCall, ordinal: number, completion: ModelAttempt) =>
  guardedResponse(response, committedBody(response, call), { call, ordinal, completion })

/**
 * A handed-off response with its body observed as it passes. A response
 * this client handed off stays guarded: its readers keep their exact typed
 * failures (timeouts, lost connections) and its model attempt. Any other
 * response is rebuilt over a Web body.
 */
export const observedResponse = (response: HttpClientResponse.HttpClientResponse, observe: (bytes: Uint8Array) => Effect.Effect<void>): Effect.Effect<HttpClientResponse.HttpClientResponse | ResilientHttpResponse> =>
  response instanceof GuardedResponse
    ? guardedResponse(response, response.stream.pipe(Stream.tap(observe)), response.modelAttempt)
    : Effect.map(Stream.toReadableStreamEffect(response.stream.pipe(Stream.tap(observe))), (body) => retainModelAttempt(response, HttpClientResponse.fromWeb(response.request, new Response(body, { status: response.status, headers: new Headers(Object.entries(response.headers)) }))))

const httpDetails = (response: HttpClientResponse.HttpClientResponse, body: string): typeof AiError.HttpContext.Type =>
  ({ request: requestDetails(response.request), response: { status: response.status, headers: Object.fromEntries(Object.entries(response.headers).filter(([key]) => ["request-id", "x-request-id", "retry-after", "retry-after-ms"].includes(key))) }, body })

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

const errorBody = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse, call: ModelRequestCall, attempt: ModelAttempt): Effect.fn.Return<string, ResilientHttpError> {
  const bytes = new Uint8Array(65536)
  const retained = yield* Ref.make(0)
  const size = yield* Stream.runFoldEffect(rejectedBody(response, call), () => 0, (size, piece) => {
    const keep = Math.min(piece.byteLength, bytes.byteLength - size)
    bytes.set(piece.subarray(0, keep), size)
    return size + piece.byteLength > bytes.byteLength
      ? Effect.fail(stampAiErrorFailure(AiError.make({ module: "Models", method: "request", reason: new AiError.InvalidResponseError({ description: modelFailureMessageOf("InvalidResponse"), http: httpDetails(response, new TextDecoder().decode(bytes)) }) }), "InvalidResponse"))
      : Ref.set(retained, size + piece.byteLength).pipe(Effect.as(size + piece.byteLength))
  }).pipe(Effect.tap((size) => observeModelBody(attempt, new TextDecoder().decode(bytes.subarray(0, size)), true)), Effect.catchTag("HttpClientError", (error) =>
    // These are byte-read failures on an already rejected response, before
    // SDK/JSON decoding. Known status and any retained evidence still apply.
    ["DecodeError", "EmptyBodyError", "TransportError"].includes(error.reason._tag)
      ? Ref.get(retained).pipe(Effect.tap((size) => observeModelBody(attempt, new TextDecoder().decode(bytes.subarray(0, size)), false))) : Effect.fail(error),
  ), Effect.tapError(() => Ref.get(retained).pipe(Effect.flatMap((size) => observeModelBody(attempt, new TextDecoder().decode(bytes.subarray(0, size)), false)))))
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
  const readyAt = ModelRequestState.match(state, { Ready: () => now, Rejected: (value) => value.retryAt ?? now, Sending: () => now, Committed: () => now, Final: () => now })
  if (readyAt > now) yield* Effect.sleep(Duration.millis(Math.min(readyAt - now, call.deadline - now)))
  if ((yield* Clock.currentTimeMillis) >= call.deadline) return yield* Effect.fail(timeoutFailure())
})

/** A committed inherited call belongs to an outer SDK consumer; a new child HTTP operation is independent. */
const requestCall = Effect.fnUntraced(function* (): Effect.fn.Return<ModelRequestCall, AiError.AiError> {
  const inherited = yield* CurrentModelRequestCall
  if (Option.isSome(inherited) && (yield* Ref.get(inherited.value.state))._tag !== "Committed") return inherited.value
  return yield* makeModelRequestCall({ reserveFallback: false })
})

/**
 * How one request is sent: its error vocabulary, whether its response is
 * settled (headers arrive only once the whole response is generated; absent:
 * every call method but a stream's is settled) and the caller's admission
 * before each physical send. The models plugin's spend guard
 * (`CurrentModelSpendGuard`) reserves after the admission, before the send.
 */
export interface ResilientRequestOptions {
  readonly protocol: ProviderFailureProtocol
  readonly settled?: boolean
  readonly beforeSend?: Effect.Effect<void, AiError.AiError>
}

/**
 * One retry owner before response handoff; successful response readers
 * retain exact typed failures. A streamed request waits for its headers at
 * most `requestTimeoutMs`; a settled one's headers come with the whole
 * generation, so they wait for the call's deadline and a timeout there is
 * final instead of a second generation.
 */
export const resilientRequest = Effect.fn("models.request")(function* <R>(client: HttpClient.HttpClient.With<HttpClientError.HttpClientError, R>, request: HttpClientRequest.HttpClientRequest, options: ResilientRequestOptions): Effect.fn.Return<ResilientHttpResponse, ResilientHttpError, R> {
  const call = yield* requestCall()
  const replayable = replayableBody(request)
  const settled = options.settled ?? (yield* CurrentModelCallMethod) !== "Stream"
  const headerBound = settled ? call.policy.totalTimeoutMs : call.policy.requestTimeoutMs
  const run = (previous: Option.Option<ResilientHttpError>): Effect.Effect<ResilientHttpResponse, ResilientHttpError, R> => Effect.gen(function* () {
    yield* awaitReady(call)
    yield* options.beforeSend ?? Effect.void
    const started = yield* Ref.modify(call.state, (state) => Option.match(startAttemptState(state, call.policy, call.reserveFallback), { onNone: () => [Option.none<number>(), state] as const, onSome: (next) => [Option.some(next.attempts), next] as const }))
    if (Option.isNone(started)) return yield* Option.match(previous, { onNone: () => Effect.fail(stampAiErrorFailure(AiError.make({ module: "Models", method: "request", reason: new AiError.InvalidRequestError({ description: modelFailureMessageOf("InvalidRequest") }) }), "InvalidRequest")), onSome: Effect.fail })
    const ordinal = started.value
    // The spend guard's hold is taken before the send and belongs to the attempt from then on: the two run
    // uninterruptibly, so an interruption never leaves a hold the ledger took without an attempt to close it.
    const attempt = yield* Effect.uninterruptible(reserveSend(request).pipe(
      Effect.flatMap((spend) => beginModelAttempt(call.completion, ordinal, options.protocol, spend)),
    ))
    const execute = Ref.set(attempt.reach, "Sent").pipe(Effect.andThen(client.execute(request)), Effect.provideService(CurrentModelRequestCall, Option.some(call)), Effect.catchTag("HttpClientError", (error) => error.reason._tag === "StatusCodeError" ? Effect.succeed(error.reason.response) : Effect.fail(error)))
    const headers = yield* Effect.result(pendingRead(execute, call, headerBound))
    const result = headers._tag === "Failure" ? headers : yield* Effect.result(Effect.suspend((): Effect.Effect<ResilientHttpResponse, ResilientHttpError> => {
      const response = headers.success
      return response.status >= 200 && response.status < 300
      ? Ref.update(call.state, (state): ModelRequestState => state._tag === "Sending" && state.attempts === ordinal ? { _tag: "Committed", rung: state.rung, attempts: ordinal } : state).pipe(Effect.andThen(wrapResponse(response, call, ordinal, attempt)))
      : Ref.set(attempt.reach, reachOfStatus(response.status)).pipe(Effect.andThen(errorBody(response, call, attempt)), Effect.flatMap((body) => Effect.fail(responseFailure(response, body, options.protocol))))
    }))
    if (result._tag === "Success") return result.success
    const failure = result.failure
    if (isTurnError(failure)) return yield* Effect.fail(failure)
    const kind = errorKind(failure)
    if (HttpClientError.isHttpClientError(failure) && failure.reason._tag === "TransportError" && neverConnected(failure.reason.cause)) yield* Ref.set(attempt.reach, "Unsent")
    // Timer completion is authoritative even when the wall clock still reads before the deadline.
    // Keep rejected-body and streamed timeouts retryable; only a possibly sent settled header wait is final.
    const finalHeaderTimeout = settled && headers._tag === "Failure" && kind === "Timeout" && (yield* Ref.get(attempt.reach)) !== "Unsent"
    yield* completeModelAttempt(attempt, { _tag: "Failed", failure: Option.some(kind) })
    const now = yield* Clock.currentTimeMillis
    const hint = AiError.isAiError(failure) && "http" in failure.reason ? retryHintMillis(failure.reason.http?.response?.headers ?? {}, now) : Option.none()
    const delay = retryDelayMillis(call.policy, ordinal, yield* Random.next, hint)
    yield* Ref.update(call.state, (state): ModelRequestState => state._tag === "Sending" && state.attempts === ordinal
      ? finalHeaderTimeout
        ? { _tag: "Final", rung: state.rung, attempts: ordinal, kind }
        : { _tag: "Rejected", rung: state.rung, attempts: ordinal, kind, replayable, ...(retryableModelFailure(kind) && replayable ? { retryAt: now + delay } : {}) }
      : state)
    const state = yield* Ref.get(call.state)
    return Option.isSome(startAttemptState(state, call.policy, call.reserveFallback)) ? yield* run(Option.some(failure)) : yield* Effect.fail(failure)
  })
  return yield* run(Option.none()).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? completePendingAttempts(call.completion, exit) : Effect.void))
})

export const resilientHttpClient = <R>(client: HttpClient.HttpClient.With<HttpClientError.HttpClientError, R>, options: { readonly protocol: ProviderFailureProtocol; readonly adaptResponse: (response: ResilientHttpResponse) => HttpClientResponse.HttpClientResponse }): HttpClient.HttpClient.With<ResilientHttpError, R> => HttpClient.makeWith(
  (prepared) => Effect.flatMap(prepared, (request) => resilientRequest(HttpClient.makeWith(client.postprocess, Effect.succeed), request, options).pipe(Effect.map(options.adaptResponse))),
  client.preprocess,
)


/** One provider invocation owns cleanup of a handed-off body that failed before raw decoding. */
export const withModelRequestCall = <A, E, R>(method: ModelCallMethod, selection: ModelSelection, operation: Effect.Effect<A, E, R>): Effect.Effect<A, E | AiError.AiError | TurnError, R> => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
  const call = yield* requestCall()
  const inherited = Option.contains(yield* CurrentModelCallMetadataOwner, call.completion.callId)
  const effectiveMethod = inherited ? yield* CurrentModelCallMethod : method
  const effectiveSelection = inherited ? yield* CurrentModelCallSelection : Option.some(selection)
  const result = yield* Effect.exit(restore(operation.pipe(
    Effect.provideService(CurrentModelRequestCall, Option.some(call)),
    Effect.provideService(CurrentModelCallMethod, effectiveMethod), Effect.provideService(CurrentModelCallSelection, effectiveSelection),
    Effect.provideService(CurrentModelCallMetadataOwner, Option.some(call.completion.callId)),
  )))
  yield* completePendingAttempts(call.completion, result)
  return yield* Exit.match(result, { onSuccess: Effect.succeed, onFailure: Effect.failCause })
}))

/** Fixed SDK streams bridge an original recorder TurnError as a defect; no data/error relabeling. */
export const withModelRequestStream = <A, E, R>(method: ModelCallMethod, selection: ModelSelection, stream: Stream.Stream<A, E, R>): Stream.Stream<A, E | AiError.AiError | TurnError, R> => Stream.unwrap(Effect.gen(function* () {
  const call = yield* requestCall()
  const inherited = Option.contains(yield* CurrentModelCallMetadataOwner, call.completion.callId)
  const effectiveMethod = inherited ? yield* CurrentModelCallMethod : method
  const effectiveSelection = inherited ? yield* CurrentModelCallSelection : Option.some(selection)
  return stream.pipe(
    Stream.provideService(CurrentModelRequestCall, Option.some(call)),
    Stream.provideService(CurrentModelCallMethod, effectiveMethod), Stream.provideService(CurrentModelCallSelection, effectiveSelection),
    Stream.provideService(CurrentModelCallMetadataOwner, Option.some(call.completion.callId)),
    Stream.onEnd(completePendingAttempts(call.completion, Exit.succeed(undefined))),
    Stream.onExit((exit) => completePendingAttempts(call.completion, Exit.isSuccess(exit) ? Exit.interrupt() : exit).pipe(Effect.catch((error) => Effect.die(error)))),
  )
}))
