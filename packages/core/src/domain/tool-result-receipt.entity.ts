import { Schema } from "effect"
import { ToolCallId } from "./message.entity.js"
import { InvocationId, RunRef } from "./run.entity.js"
import { ToolResultInterception } from "./tool-interceptor.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"

/** Private ownership target: a provider key alone cannot identify a call. */
export const ToolResultReceiptTarget = Schema.Struct({
  tool: Schema.String, toolCallId: ToolCallId, run: Schema.OptionFromNullOr(RunRef),
  step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export type ToolResultReceiptTarget = typeof ToolResultReceiptTarget.Type

const handle = { handleToken: Schema.ObjectKeyword }
const claimed = { ...handle, invocationId: InvocationId }
const ready = { ...claimed, metadata: Schema.OptionFromNullOr(ToolResultInterception) }
/** Private rule state; opaque ownership tokens never enter callback context or storage. */
export const ToolResultReceiptPhase = Schema.Union([
  Schema.TaggedStruct("Fresh", {}), Schema.TaggedStruct("Entered", handle),
  Schema.TaggedStruct("Claimed", claimed), Schema.TaggedStruct("Ready", ready),
  Schema.TaggedStruct("Recording", { recordToken: Schema.ObjectKeyword, metadata: Schema.OptionFromNullOr(ToolResultInterception) }),
  Schema.TaggedStruct("Recorded", { entry: EntryId }), Schema.TaggedStruct("Closed", {}),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ToolResultReceiptPhase = typeof ToolResultReceiptPhase.Type
