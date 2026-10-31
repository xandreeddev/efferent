import { Schema } from "effect"

/** Known token limits; an omitted bound is unknown. Output-only overrides are valid. @public */
export const ModelLimits = Schema.Struct({
  contextWindow: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  maxOutputTokens: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
})
export type ModelLimits = typeof ModelLimits.Type

/**
 * A selectable model exposed by one configured provider adapter.
 *
 * @public
 */
export const ModelCatalogEntry = Schema.Struct({
  selection: Schema.String,
  /** Human-facing route name. `selection` remains the stable persisted id. */
  label: Schema.optional(Schema.String),
  provider: Schema.String,
  credential: Schema.Literals(["api_key", "oauth", "local"]),
  /** What the model reads: text, and images when its route sends them (a host can grey out an attach button). Absent: not stated. */
  input: Schema.optionalKey(Schema.Array(Schema.Literals(["text", "image"]))),
  /** Known effective token limits; absent values have not been established. */
  limits: Schema.optionalKey(ModelLimits),
})
export type ModelCatalogEntry = typeof ModelCatalogEntry.Type
