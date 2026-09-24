import { Schema } from "effect"
export const JourneySelection = Schema.Struct({
  tiers: Schema.Array(Schema.Int.pipe(Schema.between(0, 3))),
  tools: Schema.Array(Schema.String), recipes: Schema.Array(Schema.String), ids: Schema.Array(Schema.String),
})
export type JourneySelection = typeof JourneySelection.Type
