import { Schema } from "effect"
import { EvalId, Fingerprints } from "./identity.entity.js"
import { Trial } from "./trial.entity.js"

export const GateFinding = Schema.Struct({ candidate: Schema.String, grader: Schema.String, metric: Schema.String, mode: Schema.String, passed: Schema.Boolean, measured: Schema.Int, value: Schema.OptionFromNullOr(Schema.Number), reason: Schema.String })
export const EvaluationRun = Schema.Struct({
  version: Schema.Literal(1), id: EvalId, application: Schema.NonEmptyString,
  phase: Schema.Literals(["executed", "graded"]),
  startedAt: Schema.Number, endedAt: Schema.Number, fingerprints: Fingerprints,
  trials: Schema.Array(Trial), gates: Schema.Array(GateFinding), failures: Schema.Array(Schema.String),
})
export type EvaluationRun = typeof EvaluationRun.Type
