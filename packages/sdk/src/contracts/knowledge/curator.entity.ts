import { Schema } from "effect"
import { SourceId } from "./knowledge.entity.js"

/**
 * What a curator is asked for, beside the prompt: the source it is about, which try this is (from 1), and what the
 * call is for (`extract`: read the source and say what it adds; `review`: check that reply against the source).
 * A host budgets and traces its model calls by it.
 *
 * @public
 */
export const CurationJob = Schema.Struct({
  source: SourceId,
  attempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  purpose: Schema.Literals(["extract", "review"]),
})
export type CurationJob = typeof CurationJob.Type

/**
 * A curator could not answer: the model it asks failed, was refused its budget, or answered with nothing.
 *
 * @public
 */
export class CurationFailed extends Schema.TaggedError<CurationFailed>()("CurationFailed", {
  message: Schema.String,
}) {}
