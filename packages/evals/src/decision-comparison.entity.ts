import { Schema } from "effect"
/**
 * Names one case of a decision comparison: a candidate's trial pairs with the baseline's of the same case and sample.
 *
 * @public
 */
export const DecisionCaseId = Schema.String.pipe(Schema.brand("DecisionCaseId"))
export type DecisionCaseId = typeof DecisionCaseId.Type
const Measurement = Schema.NullOr(Schema.Number.pipe(Schema.check(Schema.isFinite()), Schema.check(Schema.isGreaterThanOrEqualTo(0))))
/** @public */
export const DecisionTrial = Schema.Struct({
  candidate: Schema.String, caseId: DecisionCaseId, group: Schema.String, sample: Schema.Int,
  status: Schema.Literals(["completed", "failed", "infrastructure"]),
  passed: Schema.Boolean, quality: Measurement, latencyMs: Measurement, costUsd: Measurement,
})
export type DecisionTrial = typeof DecisionTrial.Type
/** @public */
export const SelectionObservation = Schema.Struct({
  selected: Schema.NullOr(Schema.String), acceptable: Schema.Array(Schema.String),
  probabilities: Schema.Record(Schema.String, Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })))),
})
export type SelectionObservation = typeof SelectionObservation.Type
/**
 * One spread of differences against the baseline (`compareDecisionTrials`): over the pairs measured, grouped by
 * scenario, the mean difference and a 95% bootstrap interval; none where too few groups were measured.
 *
 * @public
 */
export const DecisionDelta = Schema.Struct({
  pairs: Schema.Int, groups: Schema.Int,
  mean: Schema.NullOr(Schema.Number), low: Schema.NullOr(Schema.Number), high: Schema.NullOr(Schema.Number),
})
export type DecisionDelta = typeof DecisionDelta.Type
/**
 * One candidate against the baseline, as `compareDecisionTrials` gives it: its attempts, successes and trials that
 * measured nothing about it (`infrastructure`), its pairs with the baseline's trials and those missing, its cost and
 * latency, the differences in quality, latency and cost, and the cases the baseline passed and it failed. A schema,
 * so a caller that holds the value untyped (a page running plain JavaScript) decodes it.
 *
 * @public
 */
export const DecisionComparison = Schema.Struct({
  candidate: Schema.String,
  attempts: Schema.Int, successes: Schema.Int, infrastructure: Schema.Int,
  pairs: Schema.Int, missingPairs: Schema.Int, measuredCostCalls: Schema.Int,
  costPerSuccess: Schema.NullOr(Schema.Number),
  p50Ms: Schema.NullOr(Schema.Number), p95Ms: Schema.NullOr(Schema.Number),
  quality: DecisionDelta, latency: DecisionDelta, cost: DecisionDelta,
  regressions: Schema.Array(DecisionCaseId),
})
export type DecisionComparison = typeof DecisionComparison.Type
