import type { TokenUsage } from "./token-usage.entity.js"

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
