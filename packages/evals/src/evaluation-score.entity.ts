import { Schema } from "effect"

/** Public presentation; metric kinds/ranges and execution provenance stay on the assessment. */
export const EvaluationScore = Schema.Struct({
  key: Schema.NonEmptyString,
  score: Schema.Union(Schema.Number.pipe(Schema.finite()), Schema.Boolean, Schema.Literal("A", "B", "tie")),
  comment: Schema.String,
})
export type EvaluationScore = typeof EvaluationScore.Type
