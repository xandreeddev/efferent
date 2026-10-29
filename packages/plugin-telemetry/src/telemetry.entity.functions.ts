import { Option } from "effect"
import { costOf, usageBreakdown } from "@xandreed/core"
import type { ModelPrice, TokenUsage } from "@xandreed/core"
import { UNKNOWN_MODEL } from "./telemetry.entity.js"
import type { TokenCount, TokenKind } from "./telemetry.entity.js"

/**
 * A response's tokens by billed kind (`usageBreakdown`), the kinds it billed
 * only, in a fixed order: input, cache_read, cache_write, reasoning, output.
 * For a usage that holds core's invariants the counts sum to `totalTokens`.
 */
export const tokenCounts = (usage: TokenUsage): ReadonlyArray<TokenCount> => {
  const kinds = usageBreakdown(usage)
  const all: ReadonlyArray<readonly [TokenKind, number]> = [
    ["input", kinds.input],
    ["cache_read", kinds.cacheRead],
    ["cache_write", kinds.cacheWrite],
    ["reasoning", kinds.reasoning],
    ["output", kinds.output],
  ]
  return all.filter(([, count]) => count > 0).map(([kind, count]) => ({ kind, count }))
}

/** The model attribute of a response: its model, or `"unknown"` when it names none. */
export const modelAttribute = (model: Option.Option<string>): string => Option.getOrElse(model, () => UNKNOWN_MODEL)

/** A model's price, when the host gave one for it. */
export const priceOf = (prices: Readonly<Record<string, ModelPrice>>, model: Option.Option<string>): Option.Option<ModelPrice> =>
  Option.flatMap(model, (name) => Object.hasOwn(prices, name) ? Option.fromNullishOr(prices[name]) : Option.none())

/** What a response cost at the host's prices, when its model has one. */
export const responseCost = (prices: Readonly<Record<string, ModelPrice>>, model: Option.Option<string>, usage: TokenUsage): Option.Option<number> =>
  Option.map(priceOf(prices, model), (price) => costOf(usage, price))

/**
 * A metric's attributes: the host's constant ones, then the metric's own
 * (which win, so a host attribute never renames what a series counts).
 */
export const metricAttributesOf = (host: Readonly<Record<string, string>>, own: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
  ({ ...host, ...own })

/** A response's usage as span event attributes: the counts under efferent's names, by kind. */
export const usageEventAttributes = (usage: TokenUsage): Record<string, number> => ({
  "efferent.usage.input_tokens": usage.inputTokens,
  "efferent.usage.output_tokens": usage.outputTokens,
  "efferent.usage.cache_read_tokens": usage.cacheReadTokens,
  "efferent.usage.cache_write_tokens": usage.cacheWriteTokens,
  "efferent.usage.reasoning_tokens": usage.reasoningTokens,
  "efferent.usage.total_tokens": usage.totalTokens,
})
