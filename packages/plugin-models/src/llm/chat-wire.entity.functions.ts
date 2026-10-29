import { AiError } from "effect/ai"
import { Effect, Option, Schema } from "effect"
import { ChatCompletion, GatewayError, GatewayErrorBody, StreamChunk } from "./chat-wire.entity.js"

const invalidResponse = (moduleName: string, method: string, what: string) => (error: Schema.SchemaError): AiError.AiError =>
  AiError.make({ module: moduleName, method, reason: new AiError.InvalidResponseError({ description: `${what}: ${error.message}` }) })

const completion = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatCompletion))
const chunk = Schema.decodeUnknownEffect(Schema.fromJsonString(StreamChunk))
const json = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const errorBody = Schema.decodeUnknownOption(Schema.fromJsonString(GatewayErrorBody))
const errorObject = Schema.decodeUnknownOption(GatewayError)

/** A completion body, decoded; one that is no JSON or of the wrong shape is the provider's `InvalidResponseError`. */
export const decodeChatCompletion = (moduleName: string, text: string): Effect.Effect<ChatCompletion, AiError.AiError> =>
  completion(text).pipe(Effect.mapError(invalidResponse(moduleName, "generateText", "the completion body is not a chat completion")))

/** A `data:` line's chunk, decoded; one that is no JSON object of the chunk's shape (`null` included) is the provider's `InvalidResponseError`. */
export const decodeStreamChunk = (moduleName: string, payload: string): Effect.Effect<StreamChunk, AiError.AiError> =>
  chunk(payload).pipe(Effect.mapError(invalidResponse(moduleName, "streamText", `a data: line is not a completion chunk (${payload.slice(0, 200)})`)))

/** A tool call's arguments, parsed: the model's own output, so a failure is the caller's to name. */
export const decodeToolArguments = (text: string): Effect.Effect<unknown, Schema.SchemaError> => json(text)

/** The OpenAI error object of a failed request's body, when it has one. */
export const gatewayErrorOf = (body: string): Option.Option<GatewayError> => Option.map(errorBody(body), (decoded) => decoded.error)

/** The OpenAI error object of a stream's error chunk, when it is one. */
export const chunkErrorOf = (error: unknown): Option.Option<GatewayError> => errorObject(error)

/**
 * The error types and codes gateways report an exhausted balance or quota
 * with: OpenCode's `CreditsError`, OpenAI's `insufficient_quota` and
 * `billing_insufficient_balance`, Moonshot's `exceeded_current_quota_error`.
 */
export const QUOTA_ERRORS: ReadonlySet<string> = new Set([
  "CreditsError",
  "insufficient_quota",
  "billing_insufficient_balance",
  "exceeded_current_quota_error",
])

/**
 * Whether a failure is an exhausted balance or quota, which no retry and no
 * fallback model fixes: a 402 (Payment Required), or an error whose type or
 * code names one (`QUOTA_ERRORS`), at any status. A plain 429 is not: it is
 * a rate limit, retried. The message text is not read.
 */
export const isQuotaExhausted = (status: Option.Option<number>, error: Option.Option<GatewayError>): boolean =>
  Option.contains(status, 402) || Option.exists(error, (found) =>
    [found.type, found.code].some((name) => typeof name === "string" && QUOTA_ERRORS.has(name)))

/** Whether a gateway rejected the selected model (OpenCode's `ModelError`), whatever status it answered with. */
export const isModelRejection = (error: GatewayError): boolean =>
  error.type === "ModelError" || /model .*not supported/i.test(error.message ?? "")
