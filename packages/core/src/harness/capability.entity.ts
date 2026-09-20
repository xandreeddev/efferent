import { Schema } from "effect"

export const CapabilityTool = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  version: Schema.NonEmptyTrimmedString,
  description: Schema.NonEmptyTrimmedString,
  returns: Schema.NonEmptyTrimmedString,
  permissions: Schema.Array(Schema.String),
  inputSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  outputSchema: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})
export type CapabilityTool = typeof CapabilityTool.Type
export const CapabilityRecipe = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  version: Schema.NonEmptyTrimmedString,
  instructions: Schema.NonEmptyTrimmedString,
  tools: Schema.Array(Schema.NonEmptyTrimmedString),
})
export type CapabilityRecipe = typeof CapabilityRecipe.Type
export const CapabilityCatalog = Schema.Struct({
  version: Schema.NonEmptyTrimmedString,
  recipes: Schema.Array(CapabilityRecipe),
  tools: Schema.Array(CapabilityTool),
})
export type CapabilityCatalog = typeof CapabilityCatalog.Type
export const CapabilitySelection = Schema.Struct({
  recipes: Schema.Array(Schema.String),
  tools: Schema.Array(Schema.String),
})
export type CapabilitySelection = typeof CapabilitySelection.Type
export const ResolvedCapabilities = Schema.Struct({
  catalogVersion: Schema.String,
  recipes: Schema.Array(CapabilityRecipe),
  tools: Schema.Array(CapabilityTool),
})
export type ResolvedCapabilities = typeof ResolvedCapabilities.Type
