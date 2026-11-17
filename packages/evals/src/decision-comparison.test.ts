import { expect, test } from "bun:test"
import { compareDecisionTrials, decisionTrialOf, selectionMetrics } from "./decision-comparison.entity.functions.js"
import { Trial } from "./domain/trial.entity.js"
import { Option, Schema } from "effect"
import { DecisionCaseId, DecisionComparison } from "./decision-comparison.entity.js"
import type { DecisionTrial } from "./decision-comparison.entity.js"
const row = (candidate: string, caseId: string, values: Partial<DecisionTrial> = {}): DecisionTrial => ({ candidate, caseId: DecisionCaseId.make(caseId), group: caseId, sample: 1, status: "completed", passed: true, quality: 1, latencyMs: 100, costUsd: 0.01, ...values })
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
  expect<ReadonlyArray<string>>(report.regressions).toEqual(["a"])
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
test("every row the comparison gives decodes with DecisionComparison, so a caller holding it untyped can check it", () => {
  const rows = compareDecisionTrials([
    row("base", "a"), row("base", "b"), row("next", "a", { passed: false, costUsd: 0.002 }), row("next", "b", { status: "infrastructure", passed: false }),
  ], "base")
  expect(rows.map((one) => Schema.is(DecisionComparison)(one))).toEqual([true, true])
  expect(Schema.is(DecisionComparison)({ ...rows[1], regressions: [1] })).toBe(false)
})

/** A trial as the run writes it, decoded: one task of the family "sums", started at 1,000 and ended at 1,250. */
const trial = (status: Trial["status"], spend?: number): Trial => Schema.decodeUnknownSync(Trial)({
  version: 1, id: "run/suite/candidate/task/1", runId: "run", suiteId: "suite",
  task: { id: "sum", version: "1", runnable: "subject", dataset: "dataset", datasetVersion: "1", family: "sums", split: "validation", review: "reviewed", input: "What is 2 + 3?", reference: "5", graders: [], provenance: "test" },
  candidate: { id: "next", configuration: {}, fingerprints: {} }, sample: 2, status, startedAt: 1000, endedAt: 1250,
  output: null, evidence: null, outcome: null, transcript: [], reason: "", grades: [], ...(spend === undefined ? {} : { spend: { settled: spend } }),
})

test("a trial as the comparison reads it: completed or infrastructure by how it ended, none while it runs", () => {
  const table = (["completed", "error", "cancelled", "skipped", "running"] as const).map((status) =>
    [status, Option.map(decisionTrialOf(trial(status), { passed: true }), (row) => [row.status, row.passed])])
  expect(table).toEqual([
    ["completed", Option.some(["completed", true])],
    ["error", Option.some(["infrastructure", false])],
    ["cancelled", Option.some(["infrastructure", false])],
    ["skipped", Option.some(["infrastructure", false])],
    ["running", Option.none()],
  ])
})

test("a trial that measured nothing has no latency, so it leaves the comparison's percentiles alone", () => {
  const rows = [trial("completed"), trial("skipped"), trial("error")].flatMap((one) => Option.toArray(decisionTrialOf(one, { passed: true })))
  expect(rows.map((row) => row.latencyMs)).toEqual([250, null, null])
  const next = compareDecisionTrials([row("base", "sum"), ...rows], "base").find((one) => one.candidate === "next")
  expect([next?.p50Ms, next?.p95Ms, next?.infrastructure]).toEqual([250, 250, 2])
})

test("a row names the candidate, the task as its case, the family as its group, and keeps the latency and what was settled", () => {
  expect(decisionTrialOf(trial("completed", 0.004), { passed: false, quality: 0.5 })).toEqual(Option.some({
    candidate: "next", caseId: DecisionCaseId.make("sum"), group: "sums", sample: 2, status: "completed",
    passed: false, quality: 0.5, latencyMs: 250, costUsd: 0.004,
  }))
  // A trial that reserved nothing spent what is unknown, not zero.
  expect(Option.map(decisionTrialOf(trial("completed"), { passed: true }), (row) => [row.costUsd, row.quality])).toEqual(Option.some([null, null]))
})
