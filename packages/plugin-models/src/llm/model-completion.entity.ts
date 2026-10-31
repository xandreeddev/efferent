import { Schema } from "effect"

/** The ACK result lives in one Deferred; this phase controls claiming and outer cleanup. */
export const ModelCompletionState = Schema.Union([
  Schema.TaggedStruct("Open", {}), Schema.TaggedStruct("Recording", {}),
  Schema.TaggedStruct("Recorded", {}), Schema.TaggedStruct("RecordFailed", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ModelCompletionState = typeof ModelCompletionState.Type
