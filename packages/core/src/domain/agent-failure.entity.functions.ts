import { Match, Option } from "effect"
import { AiError } from "effect/ai"
import type { AgentFailure, AgentFailureCategory } from "./agent-failure.entity.js"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined

const numeric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Each effect/ai error reason's category; whether it is retryable is the reason's own `isRetryable`. */
const categoryOfReason = Match.typeTags<AiError.AiErrorReason, AgentFailureCategory>()({
  RateLimitError: () => "rate-limit",
  QuotaExhaustedError: () => "rate-limit",
  AuthenticationError: (reason) => reason.kind === "InsufficientPermissions" ? "authorization" : "authentication",
  ContentPolicyError: () => "validation",
  InvalidRequestError: () => "protocol",
  InvalidResponseError: () => "protocol",
  InternalProviderError: () => "transport",
  NetworkError: () => "transport",
  InvalidOutputError: () => "protocol",
  StructuredOutputError: () => "protocol",
  UnsupportedSchemaError: () => "validation",
  UnknownError: () => "unknown",
  ToolNotFoundError: () => "tool",
  ToolParameterValidationError: () => "tool",
  InvalidToolResultError: () => "tool",
  ToolResultEncodingError: () => "tool",
  ToolConfigurationError: () => "tool",
  ToolkitRequiredError: () => "tool",
  InvalidUserInputError: () => "validation",
})

/** A model the account or the provider refuses: no reason names it, so the provider's wording does. */
const modelRefusal = (message: string): Option.Option<"ModelUnavailable" | "ModelUnsupported"> =>
  /model .* is not available to .*subscription/i.test(message) ? Option.some("ModelUnavailable")
    : /model .* (?:is )?not supported/i.test(message) ? Option.some("ModelUnsupported")
    : Option.none()

/** The HTTP status a reason carries, when the provider answered. */
const statusOf = (reason: AiError.AiErrorReason): Option.Option<number> =>
  "http" in reason ? Option.fromNullishOr(reason.http?.response?.status) : Option.none()

const reasonFailure = (reason: AiError.AiErrorReason, message: string, stage: string): AgentFailure =>
  Option.match(modelRefusal(message), {
    onSome: (code) => ({ code, category: "validation", stage, message, retryable: false }),
    onNone: () => ({
      code: Option.match(statusOf(reason), { onNone: () => reason._tag, onSome: (status) => `${reason._tag}:${status}` }),
      category: categoryOfReason(reason),
      stage,
      message,
      retryable: reason.isRetryable,
    }),
  })

/** A failure that is no effect/ai error: its tag, name and status, then its wording. */
const foreignFailure = (error: unknown, stage: string): AgentFailure => {
  const value = record(error)
  const response = record(value["response"])
  const tag = text(value["_tag"]) ?? (error instanceof Error ? error.name : undefined) ?? "UnknownError"
  const status = numeric(response["status"]) ?? numeric(value["status"])
  const description = text(value["description"])
  const message = description ?? (error instanceof Error ? error.message : undefined) ?? String(error)
  const refusal = modelRefusal(message)
  const unavailable = Option.contains(refusal, "ModelUnavailable")
  const unsupported = Option.contains(refusal, "ModelUnsupported")
  const terminalQuota = /CreditsError|insufficient (?:balance|credits)|usage limit|quota exhausted/i.test(message)

  const category: AgentFailureCategory =
    unavailable || unsupported
      ? "validation"
      : terminalQuota
        ? "rate-limit"
      : /timeout/i.test(tag) || /timed? out/i.test(message)
      ? "timeout"
      : /AuthError/i.test(tag) || status === 401
        ? "authentication"
        : status === 403
          ? "authorization"
          : status === 429
            ? "rate-limit"
            : /Malformed|Parse|Decode/i.test(tag) || (status !== undefined && status >= 400 && status < 500)
              ? "protocol"
              : /Http|Request|Response|Network|Socket|Fetch/i.test(tag) || (status !== undefined && status >= 500)
                ? "transport"
                : "unknown"

  const code = unavailable ? "ModelUnavailable" : unsupported ? "ModelUnsupported" : status === undefined ? tag : `${tag}:${status}`
  const retryable = category === "timeout" || (category === "rate-limit" && !terminalQuota) || category === "transport"
  return { code, category, stage, message, retryable }
}

/**
 * Classify a failure or defect without exposing provider-specific types. An
 * effect/ai `AiError` (or a bare reason) by its reason: the code is the
 * reason's tag (`RateLimitError`, with `:<status>` when the provider
 * answered), the category the reason's, retryable as the reason says;
 * `ModelUnavailable` and `ModelUnsupported` from a refusal's wording.
 * Anything else by its `_tag`, name and `status`, its message read only
 * where those say nothing.
 *
 * @deprecated Tell a failure apart by `harnessCodeOf` and describe it with
 * `reasonOf`; a tool's returned failure is the `Failure` struct. Removed in
 * the next minor release.
 */
export const toAgentFailure = (error: unknown, stage: string): AgentFailure =>
  AiError.isAiError(error) ? reasonFailure(error.reason, error.message, stage)
    : AiError.isAiErrorReason(error) ? reasonFailure(error, error.message, stage)
    : foreignFailure(error, stage)

/**
 * Preserve a returned tool failure as structured context for hosts/evals.
 *
 * @deprecated Tell a failure apart by `harnessCodeOf` and describe it with
 * `reasonOf`; a tool's returned failure is the `Failure` struct. Removed in
 * the next minor release.
 */
export const toolResultFailure = (
  result: unknown,
  toolName: string,
): AgentFailure => {
  const value = record(result)
  const code = text(value["error"]) ?? "ToolFailure"
  const message = text(value["message"]) ?? JSON.stringify(result)
  const category: AgentFailureCategory =
    /Rejected|Incomplete|Invalid|TooMany|TooLarge/i.test(code)
      ? "validation"
      : /Store/i.test(code)
        ? "persistence"
        : "tool"
  return { code, category, stage: `tool:${toolName}`, message, retryable: category === "persistence" }
}
