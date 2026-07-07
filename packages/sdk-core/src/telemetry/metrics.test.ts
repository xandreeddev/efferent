import { describe, expect, it } from "bun:test"
import { costAttribute } from "./metrics.js"

const usage = (input: number, output: number, cacheRead: number) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  totalTokens: input + output,
})

describe("costAttribute", () => {
  it("prices a catalogued model and reports the cache-hit ratio", () => {
    // claude-haiku-4-5 = $1 / $5 / $0.1 per 1M (input/output/cache).
    // 800 fresh input + 200 cached + 500 output:
    //   (800*1 + 200*0.1 + 500*5) / 1e6 = 3320 / 1e6
    const a = costAttribute("anthropic", "claude-haiku-4-5", usage(1000, 500, 200))
    expect(a["gen_ai.cost_usd"]).toBeCloseTo(0.00332, 9)
    expect(a["gen_ai.cache_hit_ratio"]).toBeCloseTo(0.2, 9)
  })

  it("omits cost for an unpriced model but still reports cache-hit ratio", () => {
    const a = costAttribute("google", "totally-made-up-model-xyz", usage(1000, 0, 500))
    expect("gen_ai.cost_usd" in a).toBe(false)
    expect(a["gen_ai.cache_hit_ratio"]).toBeCloseTo(0.5, 9)
  })

  it("clamps cache-read to input and yields 0 ratio with no input", () => {
    expect(costAttribute("google", "x", usage(0, 0, 0))["gen_ai.cache_hit_ratio"]).toBe(0)
    // cacheRead > input is impossible billing; the ratio caps at 1.
    expect(
      costAttribute("google", "x", usage(100, 0, 999))["gen_ai.cache_hit_ratio"],
    ).toBeCloseTo(1, 9)
  })
})
