import { Schema } from "effect"

export const EvaluationId = Schema.NonEmptyTrimmedString.pipe(Schema.brand("EvaluationId"))
export const EvaluationVersion = Schema.NonEmptyTrimmedString
export const EvaluationSplit = Schema.Literal("calibration", "validation")
export const LabelReview = Schema.Literal("known", "reviewed", "provisional")
export const Metric = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("boolean"), name: Schema.NonEmptyString, value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("probability"), name: Schema.NonEmptyString, value: Schema.Number.pipe(Schema.between(0, 1)) }),
  Schema.Struct({ kind: Schema.Literal("score"), name: Schema.NonEmptyString, value: Schema.Number.pipe(Schema.finite()), min: Schema.Number.pipe(Schema.finite()), max: Schema.Number.pipe(Schema.finite()) }),
  Schema.Struct({ kind: Schema.Literal("preference"), name: Schema.NonEmptyString, value: Schema.Literal("A", "B", "tie") }),
)
export type Metric = typeof Metric.Type
export const EvaluationUsage = Schema.Struct({
  inputTokens: Schema.OptionFromNullOr(Schema.Number.pipe(Schema.nonNegative())),
  outputTokens: Schema.OptionFromNullOr(Schema.Number.pipe(Schema.nonNegative())),
  costUsd: Schema.OptionFromNullOr(Schema.Number.pipe(Schema.nonNegative())),
})
export type EvaluationUsage = typeof EvaluationUsage.Type
export const EvaluationResult = Schema.Struct({
  version: Schema.Literal(2),
  evaluator: Schema.String,
  evaluatorVersion: EvaluationVersion,
  status: Schema.Literal("scored", "error", "unavailable", "skipped"),
  metrics: Schema.Array(Metric),
  reason: Schema.OptionFromNullOr(Schema.String),
  references: Schema.Array(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  usage: EvaluationUsage,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})
export type EvaluationResult = typeof EvaluationResult.Type
export const EvaluationTrial = Schema.Struct({
  version: Schema.Literal(2),
  id: EvaluationId,
  target: Schema.String,
  kind: Schema.Literal("benchmark", "journey"),
  dataset: Schema.String,
  datasetVersion: EvaluationVersion,
  caseId: Schema.String,
  split: EvaluationSplit,
  review: LabelReview,
  candidate: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  sample: Schema.Int.pipe(Schema.positive()),
  status: Schema.Literal("completed", "error", "cancelled", "skipped"),
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  output: Schema.OptionFromNullOr(Schema.Unknown),
  evidence: Schema.OptionFromNullOr(Schema.Unknown),
  reason: Schema.OptionFromNullOr(Schema.String),
  evaluations: Schema.Array(EvaluationResult),
})
export type EvaluationTrial = typeof EvaluationTrial.Type
export class AssessmentError extends Schema.TaggedError<AssessmentError>()("AssessmentError", {
  code: Schema.Literal("invalid", "unavailable", "provider", "persistence", "timeout"),
  message: Schema.String,
}) {}
