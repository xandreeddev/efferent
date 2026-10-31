import { AnthropicClient } from "@effect/ai-anthropic"
import { OpenAiClient } from "@effect/ai-openai"
import { Effect, Match, Option, Predicate, Schema, Stream } from "effect"
import { AiError } from "effect/ai"
import type { HttpClientResponse } from "effect/http"
import { modelFailureMessageOf, stampAiErrorFailure } from "@xandreed/core"
import type { ModelFailureKind } from "@xandreed/core"
import { classifyProviderFailure } from "./provider-failure.entity.functions.js"
import { ProviderFailureEvidence } from "./provider-failure.entity.js"
import type { ProviderFailureProtocol } from "./provider-failure.entity.js"

const encodeBody = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Json))
const jsonObject = Schema.decodeUnknownOption(Schema.JsonObject)
const emptyUsage: Schema.JsonObject = {}
const ofUsage = (value: unknown): Schema.JsonObject => Option.getOrElse(jsonObject(value), () => emptyUsage)

/** Keep diagnostic HTTP facts without credentials, query values or request bodies. */
const httpDetails = (response: HttpClientResponse.HttpClientResponse, body: string): typeof AiError.HttpContext.Type => {
  const url = URL.canParse(response.request.url) ? new URL(response.request.url) : new URL("https://provider.invalid/")
  const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => ["request-id", "x-request-id", "retry-after"].includes(key)))
  return {
    request: { method: "POST", url: `${url.protocol}//${url.host}${url.pathname}`, urlParams: [], headers: {} },
    response: { status: response.status, headers }, body,
  }
}

/** A raw provider failure is data in its cause, with fixed report/model text. */
const nativeFailure = Effect.fnUntraced(function* (
  method: string,
  evidence: ProviderFailureEvidence,
  response: HttpClientResponse.HttpClientResponse,
  raw: unknown,
  requestId: string | null,
) {
  const kind = Option.getOrElse(classifyProviderFailure(evidence), (): ModelFailureKind => "Unknown")
  const body = yield* encodeBody(raw).pipe(Effect.orDie)
  const http = httpDetails(response, body)
  const metadata = evidence.protocol === "anthropic"
    ? { anthropic: { errorType: evidence.type ?? evidence.stopReason ?? null, requestId } }
    : { openai: { errorCode: evidence.code ?? null, errorType: evidence.type ?? null, requestId } }
  const description = modelFailureMessageOf(kind)
  const reason = Match.value(kind).pipe(
    Match.when("Authentication", () => new AiError.AuthenticationError({ kind: "Unknown", description, metadata, http })),
    Match.when("Quota", () => new AiError.QuotaExhaustedError({ metadata, http })),
    Match.when("RateLimit", () => new AiError.RateLimitError({ metadata, http })),
    Match.when("InvalidResponse", () => new AiError.InvalidResponseError({ description, metadata, http })),
    Match.when("Transient", () => new AiError.InternalProviderError({ description, metadata, http })),
    Match.when("Timeout", () => new AiError.InternalProviderError({ description, metadata, http })),
    Match.when("Unknown", () => new AiError.UnknownError({ description, metadata, http })),
    Match.orElse(() => new AiError.InvalidRequestError({ description, metadata, http })),
  )
  return stampAiErrorFailure(AiError.make({ module: "Models", method, reason }), kind)
})

const requestIdOf = (response: HttpClientResponse.HttpClientResponse): string | null =>
  response.headers["request-id"] ?? response.headers["x-request-id"] ?? null

/** Inspect decoded raw data before the SDK merges context overflow into a length cut. */
export const withAnthropicFailures = (client: AnthropicClient.Service): AnthropicClient.Service => ({
  ...client,
  createMessage: (options) => client.createMessage(options).pipe(Effect.flatMap(([body, response]) =>
    body.stop_reason === "model_context_window_exceeded"
      ? nativeFailure("createMessage", { protocol: "anthropic", status: response.status, stopReason: body.stop_reason }, response, body, requestIdOf(response)).pipe(Effect.flatMap(Effect.fail))
      : Effect.succeed([body, response] as [typeof body, typeof response]),
  )),
  createMessageStream: (options) => client.createMessageStream(options).pipe(Effect.map(([response, stream]) => [response,
    stream.pipe(Stream.mapAccumEffect(() => emptyUsage, (before, event) => Match.value(event).pipe(
      Match.when({ type: "error" }, (value) => nativeFailure("createMessageStream", {
        protocol: "anthropic", status: response.status, type: value.error.type, message: value.error.message,
      }, response, { event: value, usage: before }, value.request_id ?? requestIdOf(response)).pipe(Effect.flatMap(Effect.fail))),
      Match.when({ type: "message_start" }, (value) => {
        const usage = ofUsage(value.message.usage)
        return value.message.stop_reason === "model_context_window_exceeded"
          ? nativeFailure("createMessageStream", { protocol: "anthropic", status: response.status, stopReason: value.message.stop_reason }, response, { event: value, usage }, requestIdOf(response)).pipe(Effect.flatMap(Effect.fail))
          : Effect.succeed([usage, [event]] as const)
      }),
      Match.when({ type: "message_delta" }, (value) => {
        const usage = { ...before, ...Object.fromEntries(Object.entries(ofUsage(value.usage)).filter(([, count]) => count !== null)) }
        return value.delta.stop_reason === "model_context_window_exceeded"
          ? nativeFailure("createMessageStream", { protocol: "anthropic", status: response.status, stopReason: value.delta.stop_reason }, response, { event: value, usage }, requestIdOf(response)).pipe(Effect.flatMap(Effect.fail))
          : Effect.succeed([usage, [event]] as const)
      }),
      Match.orElse(() => Effect.succeed([before, [event]] as const)),
    ))),
  ] as [typeof response, typeof stream])),
})

type OpenAiBody = Effect.Success<ReturnType<OpenAiClient.Service["createResponse"]>>[0]
const openAiFailure = (method: string, body: OpenAiBody, response: HttpClientResponse.HttpClientResponse, raw: unknown = body) => nativeFailure(method, {
  protocol: "openai", status: response.status,
  ...(body.error == null ? {} : { code: body.error.code, message: body.error.message }),
}, response, raw, requestIdOf(response))

/** The same raw error interception serves native Responses and its Codex transport. */
export const withOpenAiFailures = (client: OpenAiClient.Service): OpenAiClient.Service => ({
  ...client,
  createResponse: (options) => client.createResponse(options).pipe(Effect.flatMap(([body, response]) =>
    body.error != null
      ? openAiFailure("createResponse", body, response).pipe(Effect.flatMap(Effect.fail))
      : Effect.succeed([body, response] as const),
  )),
  createResponseStream: (options) => client.createResponseStream(options).pipe(Effect.map(([response, stream]) => [response,
    stream.pipe(Stream.mapAccumEffect(() => emptyUsage, (before, event) => {
      const observed = Predicate.hasProperty(event, "response") && Predicate.hasProperty(event.response, "usage") ? ofUsage(event.response.usage) : emptyUsage
      const usage = { ...before, ...Object.fromEntries(Object.entries(observed).filter(([, count]) => count !== null)) }
      const raw = { event, usage }
      return Match.value(event).pipe(
        Match.when({ type: "error" }, (value) => nativeFailure("createResponseStream", {
          protocol: "openai", status: Schema.is(ProviderFailureEvidence.fields.status)(value.status) ? value.status : response.status,
          ...(value.code == null ? {} : { code: value.code }), message: value.message,
        }, response, raw, requestIdOf(response)).pipe(Effect.flatMap(Effect.fail))),
        Match.when({ type: "response.failed" }, (value) => openAiFailure("createResponseStream", value.response, response, raw).pipe(Effect.flatMap(Effect.fail))),
        Match.when({ response: { error: (error: unknown) => error != null } }, (value) => openAiFailure("createResponseStream", value.response, response, raw).pipe(Effect.flatMap(Effect.fail))),
        Match.orElse(() => Effect.succeed([usage, [event]] as const)),
      )
    })),
  ] as const)),
})

/** The adapter protocol the provider classifier interprets, not the configured provider alias. */
export const providerFailureProtocol = (route: "anthropic" | "openai-responses" | "openai-codex" | "compat"): ProviderFailureProtocol =>
  route === "anthropic" ? "anthropic" : route === "compat" ? "compat" : "openai"
