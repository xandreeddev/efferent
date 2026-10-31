import { Option, Schema } from "effect"
import { tokenUsage } from "@xandreed/core"
import type { ModelCallUsage } from "@xandreed/core"
import type { ProviderFailureProtocol } from "./provider-failure.entity.js"
import { AnthropicUsageCounts, OpenAiUsageCounts, ProviderUsageCounts } from "./model-usage.entity.js"
import type { ProviderUsageObservation } from "./model-usage.entity.js"

const present = (key: keyof ProviderUsageCounts, value: number | null | undefined): ProviderUsageCounts => value == null ? {} : { [key]: value }

/** Read only the supported provider's token counters before absent fields get SDK defaults. */
export const providerUsageCounts = (protocol: ProviderFailureProtocol, value: unknown, reasoning = true): Option.Option<ProviderUsageCounts> => protocol === "anthropic"
  ? Option.map(Schema.decodeUnknownOption(AnthropicUsageCounts)(value), (usage) => ({
    ...present("inputTokens", usage.input_tokens), ...present("outputTokens", usage.output_tokens),
    ...present("cacheReadTokens", usage.cache_read_input_tokens), ...present("cacheWriteTokens", usage.cache_creation_input_tokens),
  }))
  : Option.map(Schema.decodeUnknownOption(OpenAiUsageCounts)(value), (usage) => ({
    ...present("inputTokens", usage.input_tokens ?? usage.prompt_tokens), ...present("outputTokens", usage.output_tokens ?? usage.completion_tokens),
    ...present("cacheReadTokens", usage.prompt_cache_hit_tokens ?? usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens),
    ...present("cacheWriteTokens", usage.prompt_tokens_details?.cache_write_tokens ?? usage.input_tokens_details?.cache_write_tokens),
    ...(reasoning ? present("reasoningTokens", usage.output_tokens_details?.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens) : {}),
  }))

/** Reported cumulative fields replace their earlier values; null/absent fields never erase facts. */
export const observeProviderUsage = (before: ProviderUsageObservation, counts: ProviderUsageCounts, final: boolean): ProviderUsageObservation => ({ _tag: final && counts.outputTokens !== undefined ? "Final" : before._tag, counts: { ...before.counts, ...counts } })

/** Normalize the observed subtotal while preserving coverage and finality separately. */
export const modelCallUsageOf = (protocol: ProviderFailureProtocol, observation: ProviderUsageObservation): ModelCallUsage => {
  const counts = observation.counts
  const reported = (Object.keys(ProviderUsageCounts.fields) as ReadonlyArray<keyof ProviderUsageCounts>).filter((key) => counts[key] !== undefined)
  if (reported.length === 0) return { _tag: "Unknown" }
  const inputTokens = (counts.inputTokens ?? 0) + (protocol === "anthropic" ? (counts.cacheReadTokens ?? 0) + (counts.cacheWriteTokens ?? 0) : 0)
  const usage = tokenUsage({ ...counts, inputTokens, outputTokens: counts.outputTokens ?? 0 })
  if (Object.values(usage).some((count) => !Number.isSafeInteger(count))) return { _tag: "Unknown" }
  return observation._tag === "Final" && counts.inputTokens !== undefined && counts.outputTokens !== undefined
    ? { _tag: "Known", usage } : { _tag: "Partial", usage, reported }
}
