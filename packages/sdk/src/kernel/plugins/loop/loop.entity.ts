import { Schema } from "effect"

/**
 * The model asked for tools and this loop runs none: the tools it asked for.
 *
 * @public
 */
export class ToolsNotRun extends Schema.TaggedError<ToolsNotRun>()("ToolsNotRun", {
  tools: Schema.Array(Schema.String),
  message: Schema.String,
}) {}

/**
 * The model failed part-way through its answer: its stream reported an
 * error after it began. The answer so far is no answer; `cause` is what the
 * stream reported.
 *
 * @public
 */
export class ModelFailed extends Schema.TaggedError<ModelFailed>()("ModelFailed", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * A turn was asked for with a message of no text. The loop refuses it
 * before the turn opens, so nothing is stored.
 *
 * @public
 */
export class EmptyMessage extends Schema.TaggedError<EmptyMessage>()("EmptyMessage", {
  message: Schema.String,
}) {}
