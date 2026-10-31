import { Option, Predicate, Schema } from "effect"
import type { AiError } from "effect/ai"
import { ENGINE_KEY, ModelFailureStamp, modelFailureOf, stampAiErrorFailure } from "@xandreed/core"
import type { ModelFailureKind } from "@xandreed/core"
import type { ProviderFailureEvidence, ProviderFailureProtocol } from "./provider-failure.entity.js"
import { ProviderErrorBody, ProviderErrorMetadata } from "./provider-failure.entity.js"
import type { ProviderErrorDetail } from "./provider-failure.entity.js"
import { QUOTA_ERRORS } from "./chat-wire.entity.functions.js"

const quotaNames: ReadonlySet<string> = new Set([...QUOTA_ERRORS].map((name) => name.toLowerCase()).concat("insufficient_quota_error"))
const contextNames: ReadonlySet<string> = new Set(["context_length_exceeded", "context_window_exceeded", "model_context_window_exceeded"])
const authenticationNames: ReadonlySet<string> = new Set(["authentication_error", "permission_error", "invalid_api_key", "invalid_api_key_error", "invalid_authentication"])
const rateNames: ReadonlySet<string> = new Set(["rate_limit_error", "rate_limit_exceeded", "rate_limit_exceeded_error"])
const transientNames: ReadonlySet<string> = new Set(["overloaded_error", "api_error", "server_error", "service_unavailable_error"])
const timeoutNames: ReadonlySet<string> = new Set(["request_timeout", "timeout_error"])
const invalidNames: ReadonlySet<string> = new Set(["modelerror", "not_found_error", "request_too_large", "request_too_large_error", "content_policy_violation", "content_policy_error"])
const namedKinds: ReadonlyArray<readonly [ReadonlySet<string>, ModelFailureKind]> = [
  [contextNames, "ContextOverflow"], [quotaNames, "Quota"], [authenticationNames, "Authentication"],
  [rateNames, "RateLimit"], [transientNames, "Transient"], [timeoutNames, "Timeout"], [invalidNames, "InvalidRequest"],
]
const namedFailure = (name: string | undefined): Option.Option<ModelFailureKind> => Option.flatMap(Option.fromNullishOr(name), (value) =>
  Option.map(Option.fromNullishOr(namedKinds.find(([names]) => names.has(value.toLowerCase()))), ([, kind]) => kind),
)
const contextPatterns: Readonly<Record<ProviderFailureEvidence["protocol"], ReadonlyArray<RegExp>>> = {
  anthropic: [/\b(?:input|prompt|request)\b.{0,80}\bexceeds? (?:the |this model's )?context window\b/i],
  openai: [/\bmaximum context length is \d+ tokens\b/i, /\b(?:input|prompt|request)\b.{0,80}\bexceeds? (?:the |this model's )?context window\b/i],
  compat: [/\bmaximum context length is \d+ tokens\b/i, /\b(?:input|prompt|request)\b.{0,80}\bexceeds? (?:the |this model's )?context window\b/i],
}

/** Interpret only supported provider evidence; absence is not a guessed failure kind. */
export const classifyProviderFailure = (evidence: ProviderFailureEvidence): Option.Option<ModelFailureKind> => {
  if (evidence.protocol === "anthropic" && evidence.stopReason === "model_context_window_exceeded") return Option.some("ContextOverflow")
  // Specific codes outrank specific types; a generic request envelope is refined only by narrow context evidence.
  const specific = Option.orElse(namedFailure(evidence.code), () => namedFailure(evidence.type))
  if (Option.isSome(specific)) return specific
  const message = evidence.message ?? ""
  const contextMessage = contextPatterns[evidence.protocol].some((pattern) => pattern.test(message))
    || (evidence.protocol !== "openai" && evidence.status !== 413 && /\bprompt (?:is )?too long\b/i.test(message))
  if ([evidence.code, evidence.type].some((name) => name?.toLowerCase() === "invalid_request_error")) return Option.some(contextMessage ? "ContextOverflow" : "InvalidRequest")
  if (/\bmodel .*not supported\b/i.test(message)) return Option.some("InvalidRequest")
  if (evidence.status === 402) return Option.some("Quota")
  if (evidence.status === 401 || evidence.status === 403) return Option.some("Authentication")
  const contextStatus = evidence.status === undefined || [200, 400, 413, 422].includes(evidence.status)
  if (contextStatus && contextMessage) return Option.some("ContextOverflow")
  if (evidence.status === 429) return Option.some("RateLimit")
  if (evidence.status === 408 || evidence.status === 504) return Option.some("Timeout")
  if (evidence.status !== undefined && evidence.status >= 500) return Option.some("Transient")
  if (evidence.status !== undefined && evidence.status >= 400) return Option.some("InvalidRequest")
  return Option.none()
}

/** Refine provider evidence without changing an error's concrete reason or unrelated fields. */
export const classifyAiError = (error: AiError.AiError, protocol: ProviderFailureProtocol): AiError.AiError => {
  const reason = error.reason
  const metadata = "metadata" in reason ? reason.metadata : {}
  const engine = Object.hasOwn(metadata, ENGINE_KEY) ? metadata[ENGINE_KEY] : undefined
  if (Predicate.isObject(engine) && Object.hasOwn(engine, "failure") && Option.isSome(Schema.decodeUnknownOption(ModelFailureStamp)(engine))) return error
  const clientDecode = reason._tag === "InvalidOutputError" && (
    (protocol === "anthropic" && error.module === "AnthropicClient" && ["createMessage", "createMessageStream"].includes(error.method))
    || (protocol === "openai" && error.module === "OpenAiClient")
  )
  if (clientDecode) return stampAiErrorFailure(error, "InvalidResponse")
  // Model-output/tool failures keep their existing corrective contract. A network failure has no provider response.
  if (Option.isNone(modelFailureOf(error)) || reason._tag === "NetworkError") return error
  const http = "http" in reason ? reason.http : undefined
  const body = Option.flatMap(Option.fromNullishOr(http?.body), Schema.decodeUnknownOption(Schema.fromJsonString(ProviderErrorBody)))
  const namespace = protocol === "compat" ? error.module : protocol
  const provider = Schema.decodeUnknownOption(ProviderErrorMetadata)(Object.hasOwn(metadata, namespace) ? metadata[namespace] : {})
  const socket = Schema.decodeUnknownOption(ProviderErrorMetadata)(metadata)
  const details: ReadonlyArray<ProviderErrorDetail> = [
    ...Option.toArray(Option.map(body, (value) => typeof value.error === "string" ? { message: value.error } : value.error ?? value)),
    ...Option.toArray(Option.map(provider, (value) => ({ ...value, ...(value.errorCode == null ? {} : { code: value.errorCode }), ...(value.errorType == null ? {} : { type: value.errorType }) }))),
    ...Option.toArray(socket),
  ]
  const field = (key: keyof ProviderErrorDetail): Option.Option<string> => Option.fromNullishOr(details.flatMap((detail) => {
    const value = detail[key]
    return typeof value === "string" ? [value] : []
  })[0])
  const evidence: ProviderFailureEvidence = {
    protocol,
    ...(http?.response === undefined ? {} : { status: http.response.status }),
    ...Option.match(field("code"), { onNone: () => ({}), onSome: (code) => ({ code }) }),
    ...Option.match(field("type"), { onNone: () => ({}), onSome: (type) => ({ type }) }),
    message: Option.getOrElse(field("message"), () => reason.message),
  }
  return Option.match(classifyProviderFailure(evidence), { onNone: () => error, onSome: (kind) => stampAiErrorFailure(error, kind) })
}
