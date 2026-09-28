import { Schema } from "effect"

export const CapabilityTool = Schema.Struct({
  id: Schema.Trimmed.check(Schema.isNonEmpty()),
  version: Schema.Trimmed.check(Schema.isNonEmpty()),
  description: Schema.Trimmed.check(Schema.isNonEmpty()),
  returns: Schema.Trimmed.check(Schema.isNonEmpty()),
  permissions: Schema.Array(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  outputSchema: Schema.Record(Schema.String, Schema.Unknown),
})
export type CapabilityTool = typeof CapabilityTool.Type
export const CapabilityRecipe = Schema.Struct({
  id: Schema.Trimmed.check(Schema.isNonEmpty()),
  version: Schema.Trimmed.check(Schema.isNonEmpty()),
  instructions: Schema.Trimmed.check(Schema.isNonEmpty()),
  tools: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())),
})
export type CapabilityRecipe = typeof CapabilityRecipe.Type
export const CapabilityCatalog = Schema.Struct({
  version: Schema.Trimmed.check(Schema.isNonEmpty()),
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
