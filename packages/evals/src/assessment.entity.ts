import { Schema } from "effect"

export const EvaluationId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("EvaluationId"))
export const EvaluationVersion = Schema.Trimmed.check(Schema.isNonEmpty())
export const EvaluationSplit = Schema.Literals(["calibration", "validation"])
export const LabelReview = Schema.Literals(["known", "reviewed", "provisional"])
export const Metric = Schema.Union(
  [Schema.Struct({ kind: Schema.Literal("boolean"), name: Schema.NonEmptyString, comment: Schema.optional(Schema.String), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("probability"), name: Schema.NonEmptyString, comment: Schema.optional(Schema.String), value: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))) }),
  Schema.Struct({ kind: Schema.Literal("score"), name: Schema.NonEmptyString, comment: Schema.optional(Schema.String), value: Schema.Number.pipe(Schema.check(Schema.isFinite())), min: Schema.Number.pipe(Schema.check(Schema.isFinite())), max: Schema.Number.pipe(Schema.check(Schema.isFinite())) }),
  Schema.Struct({ kind: Schema.Literal("preference"), name: Schema.NonEmptyString, comment: Schema.optional(Schema.String), value: Schema.Literals(["A", "B", "tie"]) })],
)
export type Metric = typeof Metric.Type
export const EvaluationUsage = Schema.Struct({
  inputTokens: Schema.OptionFromNullOr(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  outputTokens: Schema.OptionFromNullOr(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
  costUsd: Schema.OptionFromNullOr(Schema.Number.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
})
export type EvaluationUsage = typeof EvaluationUsage.Type
export const EvaluationResult = Schema.Struct({
  version: Schema.Literal(2),
  evaluator: Schema.String,
  evaluatorVersion: EvaluationVersion,
  status: Schema.Literals(["scored", "error", "unavailable", "skipped"]),
  metrics: Schema.Array(Metric),
  reason: Schema.OptionFromNullOr(Schema.String),
  references: Schema.Array(Schema.String),
  startedAt: Schema.Number,
  endedAt: Schema.Number,
  usage: EvaluationUsage,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
})
export type EvaluationResult = typeof EvaluationResult.Type
export class AssessmentError extends Schema.TaggedError<AssessmentError>()("AssessmentError", {
  code: Schema.Literals(["invalid", "unavailable", "provider", "persistence", "timeout"]),
  message: Schema.String,
}) {}
