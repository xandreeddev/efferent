import type { AgentFailure, AgentFailureCategory } from "./agent-failure.entity.js"

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? value as Record<string, unknown> : {}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined

const numeric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

/** Classify adapter/runtime defects without exposing provider-specific types. */
export const toAgentFailure = (error: unknown, stage: string): AgentFailure => {
  const value = record(error)
  const response = record(value["response"])
  const tag = text(value["_tag"]) ?? (error instanceof Error ? error.name : undefined) ?? "UnknownError"
  const status = numeric(response["status"]) ?? numeric(value["status"])
  const description = text(value["description"])
  const message = description ?? (error instanceof Error ? error.message : undefined) ?? String(error)
  const unavailable = /model .* is not available to .*subscription/i.test(message)
  const unsupported = /model .* (?:is )?not supported/i.test(message)
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

/** Preserve a returned tool failure as structured context for hosts/evals. */
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
