import { Schema } from "effect"

/** Restrict a model call to any required tool, or one named active tool. @public */
export const ToolChoice = Schema.Union([Schema.Literal("required"), Schema.Struct({ tool: Schema.String })])
export type ToolChoice = typeof ToolChoice.Type
