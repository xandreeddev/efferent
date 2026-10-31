import { Schema } from "effect"

/** A session declines duplicate or reentrant paid summary work without waiting. */
export const SummaryAttempt = Schema.Union([
  Schema.TaggedStruct("Ready", { attempted: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Running", { frontier: Schema.String, attempted: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Failed", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type SummaryAttempt = typeof SummaryAttempt.Type
