import { Match, Option, Predicate, Schema } from "effect"
import { AiError } from "effect/ai"
import type { Response } from "effect/ai"
import type { HarnessCode } from "../harness/harness-code.entity.js"
import { mergeEngineStamp } from "./engine-stamp.entity.functions.js"
import { ENGINE_KEY } from "./engine-stamp.entity.js"
import { ModelFailureStamp } from "./model-failure.entity.js"
import type { ModelFailureKind } from "./model-failure.entity.js"

const decodeStamp = Schema.decodeUnknownOption(ModelFailureStamp)
const stampIn = (metadata: unknown): Option.Option<ModelFailureKind> => {
  if (!Predicate.isObject(metadata) || !Object.hasOwn(metadata, ENGINE_KEY)) return Option.none()
  const stamp = metadata[ENGINE_KEY]
  return Predicate.isObject(stamp) && Object.hasOwn(stamp, "failure")
    ? Option.map(decodeStamp(stamp), (value) => value.failure) : Option.none()
}
const metadataStamp = (value: unknown): Option.Option<ModelFailureKind> =>
  Predicate.hasProperty(value, "metadata") ? stampIn(value.metadata) : Option.none()
const partError = (value: unknown): Option.Option<AiError.AiError> =>
  Predicate.hasProperty(value, "type") && value.type === "error" && Predicate.hasProperty(value, "error") && AiError.isAiError(value.error)
    ? Option.some(value.error) : Option.none()
const explicitFailure = (value: unknown): Option.Option<ModelFailureKind> =>
  AiError.isAiError(value) ? metadataStamp(value.reason)
    : Option.orElse(metadataStamp(value), () => Option.flatMap(partError(value), (error) => metadataStamp(error.reason)))

const neutralFailure = (reason: AiError.AiErrorReason): Option.Option<ModelFailureKind> => Match.valueTags(reason, {
  RateLimitError: () => Option.some<ModelFailureKind>("RateLimit"),
  QuotaExhaustedError: () => Option.some<ModelFailureKind>("Quota"),
  AuthenticationError: () => Option.some<ModelFailureKind>("Authentication"),
  ContentPolicyError: () => Option.some<ModelFailureKind>("InvalidRequest"),
  InvalidRequestError: () => Option.some<ModelFailureKind>("InvalidRequest"),
  InvalidResponseError: () => Option.some<ModelFailureKind>("InvalidResponse"),
  InternalProviderError: () => Option.some<ModelFailureKind>("Transient"),
  NetworkError: (error) => Option.some<ModelFailureKind>(error.reason === "TransportError" ? "Transient" : "InvalidRequest"),
  UnknownError: () => Option.some<ModelFailureKind>("Unknown"),
  UnsupportedSchemaError: () => Option.some<ModelFailureKind>("InvalidRequest"),
  InvalidUserInputError: () => Option.some<ModelFailureKind>("InvalidRequest"),
  InvalidOutputError: () => Option.none<ModelFailureKind>(),
  StructuredOutputError: () => Option.none<ModelFailureKind>(),
  ToolNotFoundError: () => Option.none<ModelFailureKind>(),
  ToolParameterValidationError: () => Option.none<ModelFailureKind>(),
  InvalidToolResultError: () => Option.none<ModelFailureKind>(),
  ToolResultEncodingError: () => Option.none<ModelFailureKind>(),
  ToolConfigurationError: () => Option.none<ModelFailureKind>(),
  ToolkitRequiredError: () => Option.none<ModelFailureKind>(),
})
const fallbackFailure = (value: unknown): Option.Option<ModelFailureKind> =>
  AiError.isAiError(value) ? neutralFailure(value.reason)
    : AiError.isAiErrorReason(value) ? neutralFailure(value)
      : Option.flatMap(partError(value), (error) => neutralFailure(error.reason))
const firstFailure = (values: ReadonlyArray<unknown>, read: (value: unknown) => Option.Option<ModelFailureKind>): Option.Option<ModelFailureKind> =>
  Option.fromNullishOr(values.flatMap((value) => Option.toArray(read(value)))[0])

/**
 * Read explicit neutral stamps on parts, content arrays or AiError reasons before neutral reason fallback.
 * Error-part payloads are inspected only when they are AiError; causes, provider bodies and messages are never searched.
 * Unstamped malformed-output and tool errors remain unclassified. @public
 */
export const modelFailureOf = (value: unknown): Option.Option<ModelFailureKind> => Array.isArray(value)
  ? Option.orElse(firstFailure(value, explicitFailure), () => firstFailure(value, fallbackFailure))
  : Option.orElse(explicitFailure(value), () => fallbackFailure(value))

/** Stamp a response part without mutating it or replacing other metadata. @public */
export const stampPartFailure = (part: Response.AnyPart, kind: ModelFailureKind): Response.AnyPart =>
  ({ ...part, metadata: mergeEngineStamp(part.metadata, { failure: kind }) })

/** Stamp every part of a nonempty response; an empty failure uses the error channel. @public */
export const stampResponseFailure = (content: ReadonlyArray<Response.AnyPart>, kind: ModelFailureKind): ReadonlyArray<Response.AnyPart> =>
  content.map((part) => stampPartFailure(part, kind))

/** Copy a metadata-bearing reason through its concrete constructor; metadata-less reasons retain identity. */
const stampedReason = (reason: AiError.AiErrorReason, kind: ModelFailureKind): AiError.AiErrorReason => {
  const metadata = (original: AiError.ProviderMetadata) => mergeEngineStamp(original, { failure: kind })
  return Match.valueTags(reason, {
    RateLimitError: (value) => new AiError.RateLimitError({ retryAfter: value.retryAfter, http: value.http, metadata: metadata(value.metadata) }),
    QuotaExhaustedError: (value) => new AiError.QuotaExhaustedError({ resetAt: value.resetAt, http: value.http, metadata: metadata(value.metadata) }),
    AuthenticationError: (value) => new AiError.AuthenticationError({ kind: value.kind, description: value.description, http: value.http, metadata: metadata(value.metadata) }),
    ContentPolicyError: (value) => new AiError.ContentPolicyError({ description: value.description, http: value.http, metadata: metadata(value.metadata) }),
    InvalidRequestError: (value) => new AiError.InvalidRequestError({ parameter: value.parameter, constraint: value.constraint, description: value.description, http: value.http, metadata: metadata(value.metadata) }),
    InvalidResponseError: (value) => new AiError.InvalidResponseError({ description: value.description, http: value.http, metadata: metadata(value.metadata) }),
    InternalProviderError: (value) => new AiError.InternalProviderError({ description: value.description, http: value.http, metadata: metadata(value.metadata) }),
    InvalidOutputError: (value) => new AiError.InvalidOutputError({ description: value.description, usage: value.usage, metadata: metadata(value.metadata) }),
    StructuredOutputError: (value) => new AiError.StructuredOutputError({ description: value.description, responseText: value.responseText, usage: value.usage, metadata: metadata(value.metadata) }),
    UnsupportedSchemaError: (value) => new AiError.UnsupportedSchemaError({ description: value.description, metadata: metadata(value.metadata) }),
    UnknownError: (value) => new AiError.UnknownError({ description: value.description, http: value.http, metadata: metadata(value.metadata) }),
    NetworkError: (value) => value,
    ToolNotFoundError: (value) => value,
    ToolParameterValidationError: (value) => value,
    InvalidToolResultError: (value) => value,
    ToolResultEncodingError: (value) => value,
    ToolConfigurationError: (value) => value,
    ToolkitRequiredError: (value) => value,
    InvalidUserInputError: (value) => value,
  })
}

/** Preserve concrete AiError/reason classes and declared evidence while adding an explicit neutral stamp. @public */
export const stampAiErrorFailure = (error: AiError.AiError, kind: ModelFailureKind): AiError.AiError => {
  const reason = stampedReason(error.reason, kind)
  return reason === error.reason ? error : AiError.make({ module: error.module, method: error.method, reason })
}

/** The published framework code for a model failure. @public */
export const modelFailureCodeOf = (kind: ModelFailureKind): HarnessCode => ({
  ContextOverflow: "model.context-overflow", Authentication: "model.auth", InvalidRequest: "model.invalid-request",
  RateLimit: "model.rate-limit", Quota: "model.quota", Transient: "model.unavailable",
  InvalidResponse: "model.invalid-response", Timeout: "model.timeout", Unknown: "model.failed",
} satisfies Record<ModelFailureKind, HarnessCode>)[kind]

/** Fixed reporting text for a failed model request, without provider data, tags or stack frames. @public */
export const modelFailureMessageOf = (kind: ModelFailureKind): string => ({
  ContextOverflow: "The model request exceeded the context limit.",
  Authentication: "The model request could not be authenticated.",
  InvalidRequest: "The model request was rejected.",
  RateLimit: "The model request was rate limited.",
  Quota: "The model request exceeded the available quota.",
  Transient: "The model service is temporarily unavailable.",
  InvalidResponse: "The model returned an invalid response.",
  Timeout: "The model request timed out.",
  Unknown: "The model request failed.",
} satisfies Record<ModelFailureKind, string>)[kind]
