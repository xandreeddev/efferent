import { Schema } from "effect"

/** Stable, serializable failure context shared by products and evaluations. */
export const AgentFailureCategory = Schema.Literal(
  "authentication",
  "authorization",
  "rate-limit",
  "timeout",
  "transport",
  "protocol",
  "validation",
  "tool",
  "persistence",
  "unknown",
)
export type AgentFailureCategory = typeof AgentFailureCategory.Type

export const AgentFailure = Schema.Struct({
  code: Schema.String,
  category: AgentFailureCategory,
  stage: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
})
export type AgentFailure = typeof AgentFailure.Type
