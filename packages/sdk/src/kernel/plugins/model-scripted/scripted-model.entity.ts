import { Schema } from "effect"

/**
 * What a scripted model does with one call: stream these pieces as its answer, ask for tools, or fail.
 *
 * @public
 */
export const ScriptedAnswer = Schema.Union([
  Schema.TaggedStruct("Answers", { pieces: Schema.Array(Schema.String) }),
  // Streams its pieces, if any, then asks for these tools, in order.
  Schema.TaggedStruct("Calls", { pieces: Schema.Array(Schema.String), calls: Schema.Array(Schema.Struct({ name: Schema.String, params: Schema.Json })) }),
  Schema.TaggedStruct("Fails", {}),
])
export type ScriptedAnswer = typeof ScriptedAnswer.Type

/**
 * What a scripted model answers: call `n` gets the `n`th answer, and calls past the end get the last one.
 *
 * @public
 */
export const ModelScript = Schema.Array(ScriptedAnswer)
export type ModelScript = typeof ModelScript.Type
