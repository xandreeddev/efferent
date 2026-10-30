import { Schema } from "effect"

/**
 * Stable, serializable failure context shared by products and evaluations.
 *
 * @deprecated Tell a failure apart by `harnessCodeOf` and describe it with
 * `reasonOf`; a tool's returned failure is the `Failure` struct. Removed in
 * the next minor release.
 */
export const AgentFailureCategory = Schema.Literals(
  ["authentication",
  "authorization",
  "rate-limit",
  "timeout",
  "transport",
  "protocol",
  "validation",
  "tool",
  "persistence",
  "unknown"],
)
/**
 * @deprecated Tell a failure apart by `harnessCodeOf` and describe it with
 * `reasonOf`; a tool's returned failure is the `Failure` struct. Removed in
 * the next minor release.
 */
export type AgentFailureCategory = typeof AgentFailureCategory.Type

/**
 * @deprecated Tell a failure apart by `harnessCodeOf` and describe it with
 * `reasonOf`; a tool's returned failure is the `Failure` struct. Removed in
 * the next minor release.
 */
export const AgentFailure = Schema.Struct({
  code: Schema.String,
  category: AgentFailureCategory,
  stage: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
})
/**
 * @deprecated Tell a failure apart by `harnessCodeOf` and describe it with
 * `reasonOf`; a tool's returned failure is the `Failure` struct. Removed in
 * the next minor release.
 */
export type AgentFailure = typeof AgentFailure.Type
