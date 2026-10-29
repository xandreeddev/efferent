import { Effect, Schema } from "effect"

/** A count a record written before 0.14.0 lacks: it decodes as 0. */
const LaterCount = Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0)))

/**
 * Billed tokens for one model call (or a sum of them). The invariants
 * (`tokenUsage` and `extractUsage` hold them):
 * - `inputTokens` is the full input: uncached input, cache reads and cache
 *   writes (`uncachedInputTokens(u)` is the rest);
 * - `outputTokens` is the full output, reasoning included;
 * - `totalTokens = inputTokens + outputTokens`.
 * `cacheWriteTokens` and `reasoningTokens` are missing from records written
 * before 0.14.0; those decode with 0.
 */
export const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: LaterCount,
  reasoningTokens: LaterCount,
})
export type TokenUsage = typeof TokenUsage.Type

/**
 * One usage split into the five kinds a call is billed by. Each is at least
 * 0, and for a usage that holds the invariants they sum to `totalTokens`:
 * `input` is the uncached input, `output` the output without reasoning.
 */
export const UsageBreakdown = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  reasoning: Schema.Number,
  output: Schema.Number,
})
export type UsageBreakdown = typeof UsageBreakdown.Type

/**
 * A request's token budget (`budgetTokens`): an integer of at least 1. It is
 * the target memory compaction keeps each request under (system prompt,
 * tool schemas and messages, estimated), not a provider limit.
 */
export const BudgetTokens = Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1)))
export type BudgetTokens = typeof BudgetTokens.Type

const Price = Schema.Finite.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))

/**
 * A model's prices, per million tokens (in the host's currency, usually
 * USD). `reasoning` is optional: reasoning tokens are priced as output
 * without it.
 */
export const ModelPrice = Schema.Struct({
  input: Price,
  output: Price,
  cacheRead: Price,
  cacheWrite: Price,
  reasoning: Schema.optionalKey(Price),
})
export type ModelPrice = typeof ModelPrice.Type
