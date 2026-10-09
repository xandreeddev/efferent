import { Schema } from "effect"
import { EvalId, Version, Fingerprints } from "./identity.entity.js"
import { Metric, EvaluationUsage } from "../assessment.entity.js"
import { GradingContext } from "./grading-context.entity.js"

export const Grader = Schema.Struct({ id: EvalId, version: Version, kind: Schema.Literals(["code", "model", "human"]), metrics: Schema.Array(Schema.NonEmptyString), fingerprints: Fingerprints })
export type Grader = typeof Grader.Type
export const Grade = Schema.Struct({
  grader: Schema.String, version: Version, scope: Schema.String, status: Schema.Literals(["scored", "error", "unavailable", "pending", "skipped"]),
  metrics: Schema.Array(Metric), reason: Schema.String,
  context: Schema.OptionFromNullOr(GradingContext), usage: EvaluationUsage,
  startedAt: Schema.Number, endedAt: Schema.Number, metadata: Schema.Record(Schema.String, Schema.Unknown),
})
export type Grade = typeof Grade.Type
