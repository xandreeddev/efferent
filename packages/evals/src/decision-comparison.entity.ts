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
