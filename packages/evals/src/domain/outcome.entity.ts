import { Schema } from "effect"

/** @public */
export const Outcome = Schema.Struct({ state: Schema.Unknown, references: Schema.Array(Schema.String) })
export type Outcome = typeof Outcome.Type
