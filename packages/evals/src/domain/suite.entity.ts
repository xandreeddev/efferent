import { Option, Schema } from "effect"
import { EvalId, Version } from "./identity.entity.js"
import { Task } from "./task.entity.js"
import { Candidate } from "./candidate.entity.js"

/**
 * A gate bounds its metric from below, above or both; one with neither would pass any value.
 *
 * @public
 */
export const Gate = Schema.Struct({
  grader: Schema.NonEmptyString, metric: Schema.NonEmptyString,
  aggregate: Schema.Literals(["mean", "passRate"]), mode: Schema.Literals(["blocking", "diagnostic"]),
  minimum: Schema.OptionFromNullOr(Schema.Number), maximum: Schema.OptionFromNullOr(Schema.Number),
  requiresReviewedReference: Schema.Boolean,
}).check(Schema.makeFilter((gate) =>
  Option.isSome(gate.minimum) || Option.isSome(gate.maximum) ? true : "a gate needs a minimum or a maximum"))
export type Gate = typeof Gate.Type
/** @public */
export const Suite = Schema.Struct({
  id: EvalId, version: Version, purpose: Schema.Literals(["regression", "capability", "exploratory"]),
  description: Schema.String, tasks: Schema.Array(Task), candidates: Schema.Array(Candidate), gates: Schema.Array(Gate),
  repetitions: Schema.Int.check(Schema.isGreaterThan(0)), concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
  timeoutMs: Schema.Number.check(Schema.isGreaterThan(0)),
})
export type Suite = typeof Suite.Type
