import { describe, expect, it } from "bun:test"
import {
  bias,
  calibrationReport,
  cohenKappa,
  mae,
  type Pair,
  pearson,
  rmse,
  spearman,
} from "./metrics.js"

const pairs = (xs: ReadonlyArray<[number, number]>): ReadonlyArray<Pair> =>
  xs.map(([human, judge]) => ({ human, judge }))

describe("calibration metrics", () => {
  it("mae/rmse/bias are 0 for a perfect judge", () => {
    const p = pairs([
      [0, 0],
      [0.5, 0.5],
      [1, 1],
    ])
    expect(mae(p)).toBe(0)
    expect(rmse(p)).toBe(0)
    expect(bias(p)).toBe(0)
  })

  it("bias is positive when the judge is systematically lenient", () => {
    const p = pairs([
      [0, 0.2],
      [0.5, 0.7],
      [0.8, 1],
    ])
    expect(bias(p)).toBeGreaterThan(0)
    expect(mae(p)).toBeCloseTo(0.2, 6)
  })

  it("pearson is +1 for perfectly correlated, −1 for anti-correlated", () => {
    expect(pearson([0, 1, 2, 3], [1, 3, 5, 7])).toBeCloseTo(1, 6)
    expect(pearson([0, 1, 2, 3], [3, 2, 1, 0])).toBeCloseTo(-1, 6)
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0) // zero variance → 0
  })

  it("spearman catches a monotonic but non-linear relationship pearson misses", () => {
    const xs = [1, 2, 3, 4]
    const ys = [1, 4, 9, 16] // monotonic, non-linear
    expect(spearman(xs, ys)).toBeCloseTo(1, 6)
    expect(pearson(xs, ys)).toBeLessThan(1) // pearson < 1 on the curve
  })

  it("cohenKappa is 1 for perfect pass/fail agreement and ~0 at chance", () => {
    const perfect = pairs([
      [0.9, 0.8],
      [0.2, 0.1],
      [0.7, 0.6],
      [0.1, 0.3],
    ])
    expect(cohenKappa(perfect)).toBeCloseTo(1, 6)
    // Judge passes everything; human is split → no better than chance.
    const chance = pairs([
      [0.9, 0.9],
      [0.1, 0.9],
      [0.9, 0.9],
      [0.1, 0.9],
    ])
    expect(cohenKappa(chance)).toBeLessThanOrEqual(0)
  })

  it("calibrationReport surfaces a length-bias signal", () => {
    // Long outputs (length 1000) over-scored, short ones (length 10) fair.
    const rows = [
      { human: 0.2, judge: 0.9, length: 1000 },
      { human: 0.3, judge: 0.9, length: 900 },
      { human: 0.5, judge: 0.5, length: 10 },
      { human: 0.6, judge: 0.6, length: 20 },
    ]
    const r = calibrationReport(rows)
    expect(r.n).toBe(4)
    expect(r.lengthBias).toBeGreaterThan(0.3) // judge inflates long outputs
  })
})
