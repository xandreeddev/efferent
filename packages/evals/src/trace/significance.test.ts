import { describe, expect, it } from "bun:test"
import { pairedDeltaCI } from "./significance.js"

describe("pairedDeltaCI — bootstrap significance of a paired delta", () => {
  it("a consistent improvement is significant (95% CI excludes 0, > 0)", () => {
    const base = [0.2, 0.3, 0.25, 0.2, 0.3]
    const cand = [0.8, 0.9, 0.85, 0.8, 0.9] // +0.6-ish each
    const ci = pairedDeltaCI(base, cand)
    expect(ci.delta).toBeCloseTo(0.6, 1)
    expect(ci.low).toBeGreaterThan(0)
    expect(ci.significant).toBe(true)
    expect(ci.n).toBe(5)
    expect(Math.abs(ci.cohensD)).toBeGreaterThan(1.5) // large effect
  })

  it("a noisy wash (deltas straddle 0) is NOT significant", () => {
    const base = [0.5, 0.5, 0.5, 0.5]
    const cand = [0.6, 0.4, 0.55, 0.45] // mean ~0
    const ci = pairedDeltaCI(base, cand)
    expect(ci.significant).toBe(false)
    expect(ci.low).toBeLessThan(0)
    expect(ci.high).toBeGreaterThan(0)
    expect(ci.cohensD).toBeCloseTo(0, 1)
  })

  it("a consistent regression is significant + negative", () => {
    const ci = pairedDeltaCI([0.9, 0.85, 0.9, 0.95], [0.3, 0.25, 0.35, 0.3])
    expect(ci.delta).toBeLessThan(0)
    expect(ci.high).toBeLessThan(0)
    expect(ci.significant).toBe(true)
    expect(ci.cohensD).toBeLessThan(-1)
  })

  it("is deterministic — same data → identical CI (seeded)", () => {
    const base = [0.2, 0.4, 0.3]
    const cand = [0.5, 0.7, 0.6]
    expect(pairedDeltaCI(base, cand)).toEqual(pairedDeltaCI(base, cand))
  })

  it("< 2 pairs is never significant", () => {
    expect(pairedDeltaCI([0.1], [0.9]).significant).toBe(false)
    expect(pairedDeltaCI([], []).n).toBe(0)
  })

  it("a perfectly-consistent non-zero delta has unbounded effect (not negligible)", () => {
    // Every paired delta is exactly +0.6 → zero variance. The CI collapses to a
    // significant point, so the effect size must NOT read as 0/negligible.
    const ci = pairedDeltaCI([0.2, 0.2, 0.2], [0.8, 0.8, 0.8])
    expect(ci.significant).toBe(true)
    expect(ci.cohensD).toBe(Infinity)
  })

  it("an all-zero delta has zero effect and is not significant", () => {
    const ci = pairedDeltaCI([0.5, 0.5], [0.5, 0.5])
    expect(ci.cohensD).toBe(0)
    expect(ci.significant).toBe(false)
  })

  it("Bonferroni correction widens CI with more comparisons", () => {
    const base = [0.2, 0.3, 0.25, 0.2, 0.3]
    const cand = [0.8, 0.9, 0.85, 0.8, 0.9]
    const ci1 = pairedDeltaCI(base, cand, 2000, 0x5eed1e, 1)
    const ci3 = pairedDeltaCI(base, cand, 2000, 0x5eed1e, 3)
    // With 3 comparisons, the corrected CI should be wider (lower low, higher high).
    expect(ci3.low).toBeLessThanOrEqual(ci1.low)
    expect(ci3.high).toBeGreaterThanOrEqual(ci1.high)
  })
})
