import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { costOf, tokenUsage } from "@xandreed/core"
import type { ModelPrice } from "@xandreed/core"
import { metricAttributesOf, modelAttribute, priceOf, responseCost, tokenCounts } from "./telemetry.entity.functions.js"

const price: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, reasoning: 10 }

describe("tokenCounts", () => {
  test("splits a usage into its billed kinds, which sum to its total", () => {
    const usage = tokenUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 10, reasoningTokens: 5 })
    const counts = tokenCounts(usage)
    expect(counts).toEqual([
      { kind: "input", count: 60 },
      { kind: "cache_read", count: 30 },
      { kind: "cache_write", count: 10 },
      { kind: "reasoning", count: 5 },
      { kind: "output", count: 15 },
    ])
    expect(counts.reduce((sum, entry) => sum + entry.count, 0)).toBe(usage.totalTokens)
  })

  test("leaves out the kinds a response did not bill, and none is negative", () => {
    expect(tokenCounts(tokenUsage({ inputTokens: 12, outputTokens: 3 }))).toEqual([{ kind: "input", count: 12 }, { kind: "output", count: 3 }])
    expect(tokenCounts(tokenUsage({ inputTokens: 0, outputTokens: 0 }))).toEqual([])
    // A hand-built usage that breaks the invariants still counts nothing below 0.
    expect(tokenCounts({ inputTokens: 5, outputTokens: 1, totalTokens: 6, cacheReadTokens: 8, cacheWriteTokens: 0, reasoningTokens: 4 }))
      .toEqual([{ kind: "cache_read", count: 8 }, { kind: "reasoning", count: 4 }])
  })
})

describe("prices", () => {
  test("a response is priced only when its model has a price", () => {
    const usage = tokenUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, reasoningTokens: 500_000 })
    expect(priceOf({ "anthropic:claude": price }, Option.some("anthropic:claude"))).toEqual(Option.some(price))
    expect(responseCost({ "anthropic:claude": price }, Option.some("anthropic:claude"), usage)).toEqual(Option.some(costOf(usage, price)))
    expect(responseCost({ "anthropic:claude": price }, Option.some("anthropic:claude"), usage)).toEqual(Option.some(3 + 7.5 + 5))
    expect(responseCost({ "anthropic:claude": price }, Option.some("openai:gpt"), usage)).toEqual(Option.none())
    expect(responseCost({ "anthropic:claude": price }, Option.none(), usage)).toEqual(Option.none())
    // Only the record's own keys are models.
    expect(priceOf({}, Option.some("toString"))).toEqual(Option.none())
  })

  test("a response with no model is attributed to unknown", () => {
    expect([modelAttribute(Option.none()), modelAttribute(Option.some("openai:gpt"))]).toEqual(["unknown", "openai:gpt"])
  })
})

describe("metricAttributesOf", () => {
  test("the metric's own attributes win over the host's", () => {
    expect(metricAttributesOf({ "deployment.environment": "prod", "efferent.model": "x" }, { "efferent.model": "openai:gpt" }))
      .toEqual({ "deployment.environment": "prod", "efferent.model": "openai:gpt" })
  })
})
