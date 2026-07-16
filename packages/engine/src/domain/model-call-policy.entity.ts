import { Schema } from "effect"

/** `none` skips reasoning entirely — live-probed 2026-07-16 on the codex
 * subscription dialect (accepted, reasoning_tokens 0); `minimal` was
 * REJECTED there and stays out of the vocabulary. Non-codex adapters clamp
 * `none` to their nearest supported value. */
export const ReasoningEffort = Schema.Literal("none", "low", "medium", "high", "xhigh", "max")
export type ReasoningEffort = typeof ReasoningEffort.Type

export const ModelCallPolicy = Schema.Struct({
  effort: ReasoningEffort,
  maxOutputTokens: Schema.optional(Schema.Number),
})
export type ModelCallPolicy = typeof ModelCallPolicy.Type
