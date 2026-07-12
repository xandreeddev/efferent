import { Schema } from "effect"

/** Billed tokens for one model call (or a sum of them). */
export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
})
export type TokenUsage = typeof TokenUsage.Type
