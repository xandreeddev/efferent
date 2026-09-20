import { expect, test } from "bun:test"
import { aggregateTrials, scoreCalibration } from "./calibration.entity.functions.js"
test("selection precision and forbidden actions remain blocking despite perfect recall", () => {
  const result = scoreCalibration({ id: "matcher", category: "matcher", split: "validation", input: {}, expected: ["read"], forbidden: ["write"] }, { probabilities: { read: 0.9, write: 0.8 }, threshold: 0.6 })
  expect(result.recall).toBe(1)
  expect(result.precision).toBe(0.5)
  expect(result.passed).toBe(false)
  expect(result.brier).toBeCloseTo(0.325)
})
test("empty experiments never pass; failed attempts remain in aggregate metrics", () => {
  expect(aggregateTrials([]).passedAll).toBe(false)
  expect(aggregateTrials([{ passed: true, costUsd: 0.01, latencyMs: 10 }, { passed: false, costUsd: 0.02, latencyMs: 100 }])).toMatchObject({ attempts: 2, passRate: 0.5, totalCostUsd: 0.03, p95LatencyMs: 100, passedAll: false })
})
