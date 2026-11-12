import { Schema } from "effect"

/**
 * What a scripted model does with one call: stream these pieces as its answer, or fail.
 *
 * @public
 */
export const ModelAnswer = Schema.Union([
  Schema.TaggedStruct("Answers", { pieces: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Fails", {}),
])
export type ModelAnswer = typeof ModelAnswer.Type

/**
 * What the loop kit asks of the model under the loop it checks: call `n`
 * gets the `n`th answer, and calls past the end get the last one.
 */
export const LoopScript = Schema.Array(ModelAnswer)
export type LoopScript = typeof LoopScript.Type
