import { Schema } from "effect"

export const EvalId = Schema.NonEmptyString.pipe(Schema.brand("EvalId"))
export const Version = Schema.NonEmptyString
export const Fingerprints = Schema.Record(Schema.String, Schema.String)
export class EvaluationError extends Schema.TaggedError<EvaluationError>()("EvaluationError", {
  code: Schema.Literals(["invalid", "unavailable", "execution", "persistence", "provider", "budget", "timeout"]),
  message: Schema.String,
}) {}
