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
