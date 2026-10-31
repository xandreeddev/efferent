import { Schema } from "effect"

const count = Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
/** Reported cumulative counts; an absent field is not a reported zero. */
export const ProviderUsageCounts = Schema.Struct({ inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count, reasoningTokens: count })
export type ProviderUsageCounts = typeof ProviderUsageCounts.Type
export const ProviderUsageObservation = Schema.Union([
  Schema.TaggedStruct("Collecting", { counts: ProviderUsageCounts }),
  Schema.TaggedStruct("Final", { counts: ProviderUsageCounts }),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ProviderUsageObservation = typeof ProviderUsageObservation.Type
export const noProviderUsage: ProviderUsageObservation = { _tag: "Collecting", counts: {} }

const wireCount = Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))))
export const AnthropicUsageCounts = Schema.Struct({ input_tokens: wireCount, output_tokens: wireCount, cache_read_input_tokens: wireCount, cache_creation_input_tokens: wireCount })
export const OpenAiUsageCounts = Schema.Struct({
  input_tokens: wireCount, prompt_tokens: wireCount, output_tokens: wireCount, completion_tokens: wireCount,
  prompt_cache_hit_tokens: wireCount, cached_tokens: wireCount,
  input_tokens_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ cached_tokens: wireCount, cache_write_tokens: wireCount }))),
  prompt_tokens_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ cached_tokens: wireCount, cache_write_tokens: wireCount }))),
  output_tokens_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ reasoning_tokens: wireCount }))),
  completion_tokens_details: Schema.optionalKey(Schema.NullOr(Schema.Struct({ reasoning_tokens: wireCount }))),
})

/** The usage envelope is observed before downstream completion/schema acceptance. */
export const ProviderUsageBody = Schema.Struct({ usage: Schema.optionalKey(Schema.Unknown) })
