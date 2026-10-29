import { Schema } from "effect"

/** A selectable model exposed by one configured provider adapter. */
export const ModelCatalogEntry = Schema.Struct({
  selection: Schema.String,
  /** Human-facing route name. `selection` remains the stable persisted id. */
  label: Schema.optional(Schema.String),
  provider: Schema.String,
  credential: Schema.Literals(["api_key", "oauth", "local"]),
  /** What the model reads: text, and images when its route sends them (a host can grey out an attach button). Absent: not stated. */
  input: Schema.optionalKey(Schema.Array(Schema.Literals(["text", "image"]))),
})
export type ModelCatalogEntry = typeof ModelCatalogEntry.Type
