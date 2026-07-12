import { Schema } from "effect"

/** A selectable model exposed by one configured provider adapter. */
export const ModelCatalogEntry = Schema.Struct({
  selection: Schema.String,
  /** Human-facing route name. `selection` remains the stable persisted id. */
  label: Schema.optional(Schema.String),
  provider: Schema.String,
  credential: Schema.Literal("api_key", "oauth", "local"),
})
export type ModelCatalogEntry = typeof ModelCatalogEntry.Type
