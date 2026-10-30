import { Schema } from "effect"
import { BudgetTokens } from "./token-usage.entity.js"
import type { ModelPrice, TokenUsage, UsageBreakdown } from "./token-usage.entity.js"

/** Whether a value is a valid token budget: an integer of at least 1 (`BudgetTokens`). */
export const isBudgetTokens: (value: unknown) => value is BudgetTokens = Schema.is(BudgetTokens)

export const zeroUsage: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
}

const count = (value: number | undefined): number => Math.max(0, value ?? 0)

/**
 * A usage from a call's counts, with the invariants held: the input covers
 * its cache reads and writes, the output covers its reasoning (a provider
 * reporting more reasoning than output gets output = reasoning), the total
 * is input plus output, and no count is negative.
 */
export const tokenUsage = (counts: {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens?: number
  readonly cacheWriteTokens?: number
  readonly reasoningTokens?: number
}): TokenUsage => {
  const cacheReadTokens = count(counts.cacheReadTokens)
  const cacheWriteTokens = count(counts.cacheWriteTokens)
  const reasoningTokens = count(counts.reasoningTokens)
  const inputTokens = Math.max(count(counts.inputTokens), cacheReadTokens + cacheWriteTokens)
  const outputTokens = Math.max(count(counts.outputTokens), reasoningTokens)
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens }
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  totalTokens: a.totalTokens + b.totalTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  reasoningTokens: a.reasoningTokens + b.reasoningTokens,
})

/** The sum of many usages; `zeroUsage` for none. */
export const sumUsage = (usages: ReadonlyArray<TokenUsage>): TokenUsage => usages.reduce(addUsage, zeroUsage)

/**
 * The input neither read from nor written to a cache: input minus both, at
 * least 0.
 *
 * @public
 */
export const uncachedInputTokens = (usage: TokenUsage): number =>
  Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens)

/** The five billed kinds of a usage, each at least 0 (see `UsageBreakdown`). */
export const usageBreakdown = (usage: TokenUsage): UsageBreakdown => ({
  input: uncachedInputTokens(usage),
  cacheRead: Math.max(0, usage.cacheReadTokens),
  cacheWrite: Math.max(0, usage.cacheWriteTokens),
  reasoning: Math.max(0, usage.reasoningTokens),
  output: Math.max(0, usage.outputTokens - usage.reasoningTokens),
})

/**
 * What a usage costs at `price` (per million tokens): each kind of
 * `usageBreakdown` at its price, reasoning at `price.reasoning` or else
 * the output price. Cache writes have one price (a provider's different
 * write durations are not told apart).
 */
export const costOf = (usage: TokenUsage, price: ModelPrice): number => {
  const kinds = usageBreakdown(usage)
  return (
    kinds.input * price.input +
    kinds.cacheRead * price.cacheRead +
    kinds.cacheWrite * price.cacheWrite +
    kinds.reasoning * (price.reasoning ?? price.output) +
    kinds.output * price.output
  ) / 1_000_000
}
