import { Schema } from "effect"
import { liveEvent } from "@xandreed/core"

/**
 * A model's answer that failed after a word of it was handed on: its stream failed, or the model reported an error in
 * it. It is not retried and not handed to another model: an answer cannot be unsaid, and a second one would be read
 * after the first one's words. `message` is the failure's own words; `cause` is the failure.
 *
 * @public
 */
export class AnswerCut extends Schema.TaggedError<AnswerCut>()("AnswerCut", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * What one attempt of a planned model call came to, as `plugin.model.attempt` says it: `started`, then `succeeded`
 * or `failed` (with the failure's words); `attempt` counts every attempt of the call from one, and `step` is the
 * place, from zero, of the plan's step that made it (its first model, then the models it falls back to). `failed`
 * says how the attempt's stream ended for its reader too: a reader that failed (an `onText` that failed) ends it
 * `failed` in its own words, with no attempt after it.
 *
 * @public
 */
export const AttemptData = Schema.Struct({
  outcome: Schema.Literals(["started", "succeeded", "failed"]),
  attempt: Schema.Int,
  step: Schema.Int,
  reason: Schema.optionalKey(Schema.String),
})
export type AttemptData = typeof AttemptData.Type

/**
 * `plugin.model.attempt`: one attempt of a planned model call, published about the turn the call is for. Live:
 * nothing of it is stored, so a retry that succeeded leaves no record, and a client shows it as it happens.
 *
 * @public
 */
export const attemptEvent = liveEvent("model", "attempt", { tags: ["trace"], data: AttemptData })
