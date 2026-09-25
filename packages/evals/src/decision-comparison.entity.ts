import { Schema } from "effect"
const Measurement = Schema.NullOr(Schema.Number.pipe(Schema.finite(), Schema.nonNegative()))
export const DecisionTrial = Schema.Struct({
  candidate: Schema.String, caseId: Schema.String, group: Schema.String, sample: Schema.Int,
  status: Schema.Literal("completed", "failed", "infrastructure"),
  passed: Schema.Boolean, quality: Measurement, latencyMs: Measurement, costUsd: Measurement,
})
export type DecisionTrial = typeof DecisionTrial.Type
export const SelectionObservation = Schema.Struct({
  selected: Schema.NullOr(Schema.String), acceptable: Schema.Array(Schema.String),
  probabilities: Schema.Record({ key: Schema.String, value: Schema.Number.pipe(Schema.between(0, 1)) }),
})
export type SelectionObservation = typeof SelectionObservation.Type
