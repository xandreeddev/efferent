import { Schema } from "effect"
import { SessionId } from "@xandreed/core/kernel"

/**
 * What a turn is run with: the session and the user's message.
 *
 * @public
 */
export const TurnInput = Schema.Struct({ session: SessionId, message: Schema.String })
export type TurnInput = typeof TurnInput.Type

/**
 * What a turn answers its user with.
 *
 * @public
 */
export const Reply = Schema.Struct({ text: Schema.String })
export type Reply = typeof Reply.Type

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
 *
 * @public
 */
export const LoopScript = Schema.Array(ModelAnswer)
export type LoopScript = typeof LoopScript.Type
