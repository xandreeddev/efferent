import { Schema } from "effect"
import { ModelCallData, ModelCallLegacyUsage } from "@xandreed/core"

export const ObservedModelCall = Schema.Struct({ data: ModelCallData, replayed: Schema.Boolean })
export type ObservedModelCall = typeof ObservedModelCall.Type

const facts = { calls: Schema.Array(ObservedModelCall), legacy: Schema.Array(ModelCallLegacyUsage) }
export const ModelCallRecorderPhase = Schema.Union([
  Schema.TaggedStruct("Open", facts),
  Schema.TaggedStruct("Closed", facts),
]).pipe(Schema.toTaggedUnion("_tag"))
export type ModelCallRecorderPhase = typeof ModelCallRecorderPhase.Type
