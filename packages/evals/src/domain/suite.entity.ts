import { Schema } from "effect"
import { EvalId, Version } from "./identity.entity.js"
import { Task } from "./task.entity.js"
import { Candidate } from "./candidate.entity.js"

export const Gate = Schema.Struct({
  grader: Schema.NonEmptyString, metric: Schema.NonEmptyString,
  aggregate: Schema.Literals(["mean", "passRate"]), mode: Schema.Literals(["blocking", "diagnostic"]),
  minimum: Schema.OptionFromNullOr(Schema.Number), maximum: Schema.OptionFromNullOr(Schema.Number),
  requiresReviewedReference: Schema.Boolean,
})
export type Gate = typeof Gate.Type
export const Suite = Schema.Struct({
  id: EvalId, version: Version, purpose: Schema.Literals(["regression", "capability", "exploratory"]),
  description: Schema.String, tasks: Schema.Array(Task), candidates: Schema.Array(Candidate), gates: Schema.Array(Gate),
  repetitions: Schema.Int.check(Schema.isGreaterThan(0)), concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  timeoutMs: Schema.Number.check(Schema.isGreaterThan(0)),
})
export type Suite = typeof Suite.Type
