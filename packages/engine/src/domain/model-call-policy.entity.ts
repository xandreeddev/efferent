import { Schema } from "effect"

export const ReasoningEffort = Schema.Literal("low", "medium", "high", "xhigh", "max")
export type ReasoningEffort = typeof ReasoningEffort.Type

export const ModelCallPolicy = Schema.Struct({
  effort: ReasoningEffort,
  maxOutputTokens: Schema.optional(Schema.Number),
})
export type ModelCallPolicy = typeof ModelCallPolicy.Type
