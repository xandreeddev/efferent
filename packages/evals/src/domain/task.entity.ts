import { Schema } from "effect"
import { EvalId, Version } from "./identity.entity.js"

/** @public */
export const GraderBinding = Schema.Struct({ grader: Schema.NonEmptyString, projection: Schema.NonEmptyString, scope: Schema.String })
/** @public */
export const Task = Schema.Struct({
  id: EvalId, version: Version, runnable: Schema.NonEmptyString,
  dataset: Schema.NonEmptyString, datasetVersion: Version, family: Schema.NonEmptyString,
  split: Schema.NonEmptyString, review: Schema.Literals(["known", "reviewed", "provisional"]),
  input: Schema.Json, reference: Schema.Unknown, graders: Schema.Array(GraderBinding),
  provenance: Schema.NonEmptyString,
})
export type Task = typeof Task.Type
