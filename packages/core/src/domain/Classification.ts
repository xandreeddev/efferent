import { Schema } from "effect"

export const Intent = Schema.Literal(
  "add_todo",
  "list_todos",
  "complete_todo",
  "ask",
  "other",
)
export type Intent = typeof Intent.Type

export const Classification = Schema.Struct({
  intent: Intent,
  confidence: Schema.Number.pipe(Schema.between(0, 1)),
  reasoning: Schema.String,
})
export type Classification = typeof Classification.Type
