import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import fc from "fast-check"
import { ModelPrice, TokenUsage } from "./token-usage.entity.js"
import { addUsage, costOf, sumUsage, tokenUsage, uncachedInputTokens, usageBreakdown, zeroUsage } from "./token-usage.entity.functions.js"

const decode = Schema.decodeUnknownSync(TokenUsage)
const encode = Schema.encodeSync(TokenUsage)

describe("TokenUsage", () => {
  test("a record written before 0.14.0 decodes with 0 cache-write and reasoning tokens", () => {
    expect(decode({ inputTokens: 100, outputTokens: 7, totalTokens: 107, cacheReadTokens: 90 })).toEqual({
      inputTokens: 100, outputTokens: 7, totalTokens: 107, cacheReadTokens: 90, cacheWriteTokens: 0, reasoningTokens: 0,
    })
  })

  test("encodes every count, and round-trips", () => {
    const usage = tokenUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 30, reasoningTokens: 8 })
    expect(Object.keys(encode(usage))).toEqual(["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"])
    expect(decode(encode(usage))).toEqual(usage)
  })
})

describe("tokenUsage", () => {
  test("totals input and output", () => {
    expect(tokenUsage({ inputTokens: 10, outputTokens: 5 })).toEqual({
      inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
    })
  })

  test("holds the invariants: output covers reasoning, input covers both cache counts, no count is negative", () => {
    expect(tokenUsage({ inputTokens: 10, outputTokens: 4, reasoningTokens: 9 })).toMatchObject({ outputTokens: 9, totalTokens: 19 })
    expect(tokenUsage({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 8, cacheWriteTokens: 5 })).toMatchObject({ inputTokens: 13, totalTokens: 13 })
    expect(tokenUsage({ inputTokens: -3, outputTokens: -1, cacheReadTokens: -2 })).toEqual(zeroUsage)
  })
})

describe("addUsage", () => {
  test("adds every count", () => {
    const a = tokenUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 30, reasoningTokens: 8 })
    const b = tokenUsage({ inputTokens: 50, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: 2 })
    expect(addUsage(a, b)).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180, cacheReadTokens: 100, cacheWriteTokens: 30, reasoningTokens: 10 })
    expect(sumUsage([a, b])).toEqual(addUsage(a, b))
    expect(sumUsage([])).toEqual(zeroUsage)
  })
})

describe("uncachedInputTokens and usageBreakdown", () => {
  test("the uncached input is the input without its cache reads and writes, at least 0", () => {
    expect(uncachedInputTokens(tokenUsage({ inputTokens: 100, outputTokens: 0, cacheReadTokens: 60, cacheWriteTokens: 30 }))).toBe(10)
    // A hand-built usage that breaks the invariant still reads no negative count.
    expect(uncachedInputTokens({ ...zeroUsage, inputTokens: 5, cacheReadTokens: 9 })).toBe(0)
  })

  test("splits a usage into the five billed kinds", () => {
    expect(usageBreakdown(tokenUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 30, reasoningTokens: 8 }))).toEqual({
      input: 10, cacheRead: 60, cacheWrite: 30, reasoning: 8, output: 12,
    })
  })

  const count = fc.integer({ min: 0, max: 1_000_000 })
  const counts = fc.record({
    inputTokens: count, outputTokens: count, cacheReadTokens: count, cacheWriteTokens: count, reasoningTokens: count,
  })

  test("the kinds are never negative and sum to totalTokens, for one usage and for sums of them", () => {
    fc.assert(fc.property(fc.array(counts, { maxLength: 6 }), (calls) => {
      const usages = calls.map(tokenUsage)
      return [...usages, sumUsage(usages)].every((usage) => {
        const kinds = Object.values(usageBreakdown(usage))
        return kinds.every((kind) => kind >= 0) && kinds.reduce((sum, kind) => sum + kind, 0) === usage.totalTokens
      })
    }))
  })
})

describe("costOf", () => {
  const price = Schema.decodeUnknownSync(ModelPrice)({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })
  const usage = tokenUsage({ inputTokens: 1_100_000, outputTokens: 200_000, cacheReadTokens: 500_000, cacheWriteTokens: 100_000, reasoningTokens: 50_000 })

  test("prices each kind per million tokens, reasoning as output without a reasoning price", () => {
    // 0.5M uncached × 3 + 0.5M read × 0.3 + 0.1M written × 3.75 + 0.2M output (reasoning included) × 15
    expect(costOf(usage, price)).toBeCloseTo(1.5 + 0.15 + 0.375 + 3, 10)
  })

  test("a reasoning price applies to the reasoning share only", () => {
    expect(costOf(usage, { ...price, reasoning: 5 })).toBeCloseTo(1.5 + 0.15 + 0.375 + 0.05 * 5 + 0.15 * 15, 10)
    expect(costOf(zeroUsage, price)).toBe(0)
  })

  test("a negative price does not decode", () => {
    expect(Schema.decodeUnknownOption(ModelPrice)({ input: -1, output: 1, cacheRead: 1, cacheWrite: 1 })._tag).toBe("None")
  })
})
