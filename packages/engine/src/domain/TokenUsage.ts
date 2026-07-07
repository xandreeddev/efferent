import { Schema } from "effect"

/** Billed tokens for one model call (or a sum of them). */
export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
})
export type TokenUsage = typeof TokenUsage.Type

export const zeroUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
})
