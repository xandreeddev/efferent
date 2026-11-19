import { Schema } from "effect"

/**
 * A model's stream reported an error part-way: an answer cut by one is no
 * answer, and nothing of it is stored. `message` is the error's own.
 *
 * @public
 */
export class ModelAnswerFailed extends Schema.TaggedError<ModelAnswerFailed>()("ModelAnswerFailed", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
