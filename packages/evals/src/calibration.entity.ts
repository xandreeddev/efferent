import { Schema } from "effect"

export const CalibrationCase = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  category: Schema.Literal("matcher", "guardrail", "grounding", "visualizer", "helpfulness"),
  split: Schema.Literal("calibration", "validation"),
  input: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  expected: Schema.Array(Schema.String),
  forbidden: Schema.Array(Schema.String),
})
export type CalibrationCase = typeof CalibrationCase.Type
export const CalibrationPrediction = Schema.Struct({
  probabilities: Schema.Record({ key: Schema.String, value: Schema.Number.pipe(Schema.between(0, 1)) }),
  threshold: Schema.Number.pipe(Schema.between(0, 1)),
})
export type CalibrationPrediction = typeof CalibrationPrediction.Type
export const CalibrationResult = Schema.Struct({
  caseId: Schema.String, predicted: Schema.Array(Schema.String),
  precision: Schema.Number, recall: Schema.Number, f2: Schema.Number,
  brier: Schema.Number, forbidden: Schema.Array(Schema.String), passed: Schema.Boolean,
})
export type CalibrationResult = typeof CalibrationResult.Type
export const ExperimentCandidate = Schema.Struct({
  id: Schema.String, model: Schema.String, promptVersion: Schema.String,
  schemaVersion: Schema.String, settings: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})
export type ExperimentCandidate = typeof ExperimentCandidate.Type
export const Experiment = Schema.Struct({
  id: Schema.String, datasetVersion: Schema.String,
  candidate: ExperimentCandidate, repetitions: Schema.Int.pipe(Schema.between(1, 100)),
  tier: Schema.Literal("blocking", "quality", "exploratory"),
})
export type Experiment = typeof Experiment.Type
