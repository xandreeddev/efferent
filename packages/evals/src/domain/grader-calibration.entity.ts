import { Schema } from "effect"
import { Metric } from "../assessment.entity.js"

/** Labels describe grader behavior, including an honest refusal to score missing evidence. */
export const CalibrationObservation = Schema.Struct({
  status: Schema.Literals(["scored", "unavailable", "error", "pending", "skipped"]),
  metrics: Schema.Array(Metric),
  reason: Schema.String,
})
export type CalibrationObservation = typeof CalibrationObservation.Type
export const CalibrationReference = Schema.Struct({
  status: CalibrationObservation.fields.status,
  metrics: Schema.Array(Schema.Struct({
    metric: Metric,
    tolerance: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0)),
  })),
})
export type CalibrationReference = typeof CalibrationReference.Type
