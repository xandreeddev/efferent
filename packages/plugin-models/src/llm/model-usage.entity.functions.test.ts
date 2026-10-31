import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { modelCallUsageOf, observeProviderUsage, providerUsageCounts } from "./model-usage.entity.functions.js"
import { noProviderUsage } from "./model-usage.entity.js"

describe("model accounting usage observations", () => {
  test("missing counters stay Unknown while an explicit final zero is Known", () => {
    expect(modelCallUsageOf("compat", observeProviderUsage(noProviderUsage, {}, true))).toEqual({ _tag: "Unknown" })
    expect(modelCallUsageOf("compat", observeProviderUsage(noProviderUsage, { inputTokens: 0, outputTokens: 0 }, true))).toEqual({ _tag: "Known", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
  })
  test("cumulative snapshots replace only reported fields; partial output is never known final zero", () => {
    const first = observeProviderUsage(noProviderUsage, { inputTokens: 10, outputTokens: 0 }, false)
    expect(modelCallUsageOf("openai", observeProviderUsage(first, {}, true))._tag).toBe("Partial")
    const second = observeProviderUsage(first, { outputTokens: 3 }, false)
    expect(modelCallUsageOf("openai", second)).toEqual({ _tag: "Partial", reported: ["inputTokens", "outputTokens"], usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
    expect(modelCallUsageOf("openai", observeProviderUsage(second, { outputTokens: 3 }, true))).toEqual({ _tag: "Known", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
  })
  test("native and gateway counters preserve cache/reasoning shares and Anthropic exclusive input", () => {
    expect(providerUsageCounts("anthropic", { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 20, cache_creation_input_tokens: 5 })).toEqual(Option.some({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 5 }))
    const observed = observeProviderUsage(noProviderUsage, { inputTokens: 10, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 5 }, true)
    expect(modelCallUsageOf("anthropic", observed)).toEqual({ _tag: "Known", usage: { inputTokens: 35, outputTokens: 4, totalTokens: 39, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 0 } })
    expect(providerUsageCounts("openai", { input_tokens: 35, output_tokens: 8, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 5 }, output_tokens_details: { reasoning_tokens: 3 } })).toEqual(Option.some({ inputTokens: 35, outputTokens: 8, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 3 }))
    expect(providerUsageCounts("compat", { prompt_tokens: 35, completion_tokens: 8, prompt_cache_hit_tokens: 20, prompt_tokens_details: { cache_write_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 3 } })).toEqual(Option.some({ inputTokens: 35, outputTokens: 8, cacheReadTokens: 20, cacheWriteTokens: 5, reasoningTokens: 3 }))
    expect(providerUsageCounts("compat", { prompt_tokens: 35, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 } }, false)).toEqual(Option.some({ inputTokens: 35, outputTokens: 8 }))
  })
  test("null counters do not erase facts and invalid counts cannot become Known zero", () => {
    expect(providerUsageCounts("compat", { prompt_tokens: null, completion_tokens: 3 })).toEqual(Option.some({ outputTokens: 3 }))
    ;[-1, 0.5, NaN, Infinity].forEach(input_tokens => expect(providerUsageCounts("openai", { input_tokens, output_tokens: 0 })).toEqual(Option.none()))
    const final = observeProviderUsage(noProviderUsage, { inputTokens: 2, outputTokens: 1 }, true)
    expect(modelCallUsageOf("openai", observeProviderUsage(final, {}, false))).toEqual(modelCallUsageOf("openai", final))
  })
})
