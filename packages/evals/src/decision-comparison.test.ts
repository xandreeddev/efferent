import { expect, test } from "bun:test"
import { compareDecisionTrials, selectionMetrics } from "./decision-comparison.entity.functions.js"
import type { DecisionTrial } from "./decision-comparison.entity.js"
const row = (candidate: string, caseId: string, values: Partial<DecisionTrial> = {}): DecisionTrial => ({ candidate, caseId, group: caseId, sample: 1, status: "completed", passed: true, quality: 1, latencyMs: 100, costUsd: 0.01, ...values })
test("missing costs and pairs cannot become free wins", () => {
  const report = compareDecisionTrials([row("base", "a"), row("base", "b"), row("next", "a", { costUsd: null })], "base")[1]!
  expect(report.missingPairs).toBe(1)
  expect(report.costPerSuccess).toBeNull()
  expect(report.cost.mean).toBeNull()
  expect(report.quality.low).toBeNull()
})
test("failed costs count and infrastructure is distinct", () => {
  const report = compareDecisionTrials([row("base", "a"), row("base", "b"), row("next", "a", { passed: false, status: "failed" }), row("next", "b", { status: "infrastructure", passed: false })], "base")[1]!
  expect(report.infrastructure).toBe(1)
  expect(report.regressions).toEqual(["a"])
  expect(report.costPerSuccess).toBeNull()
})
test("bootstrap keeps translations and repetitions in their scenario group", () => {
  const rows = [row("base", "a"), row("base", "b"), row("next", "a", { costUsd: .005 }), row("next", "b", { costUsd: .005 })]
  const report = compareDecisionTrials(rows, "base")[1]!
  expect(report.cost.low).toBeCloseTo(-.005)
  expect(compareDecisionTrials(rows, "base")).toEqual(compareDecisionTrials(rows, "base"))
})
test("choice calibration excludes ambiguous gold labels from Brier", () => {
  const result = selectionMetrics([{ selected: "a", acceptable: ["a", "b"], probabilities: { a: .8, b: .2 } }, { selected: null, acceptable: [], probabilities: { abstain: .9, a: .1 } }])
  expect(result.coverage).toBe(.5)
  expect(result.acceptedErrorRate).toBe(0)
  expect(result.probabilityCases).toBe(1)
  expect(result.brier).toBeCloseTo(.02)
})

test("bootstrap samples groups independently, including repeated selections", () => {
  const report = compareDecisionTrials([row("base", "a"), row("base", "b"), row("next", "a", { latencyMs: 50 }), row("next", "b", { latencyMs: 200 })], "base")[1]!
  expect(report.latency.low).toBe(-50)
  expect(report.latency.high).toBe(100)
})
