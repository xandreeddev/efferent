import { Schema } from "effect"

const facts = {
  visibility: Schema.Literals(["Silent", "Visible"]),
  media: Schema.Literals(["Available", "Used"]),
  overflow: Schema.Literals(["Available", "Used"]),
}

/** One started step's recovery allowances and stream capability. */
export const RequestAttempt = Schema.Union([
  Schema.TaggedStruct("Streamable", facts),
  Schema.TaggedStruct("SettledOnly", facts),
]).pipe(Schema.toTaggedUnion("_tag"))
export type RequestAttempt = typeof RequestAttempt.Type
