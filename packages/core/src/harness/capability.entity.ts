import { Schema } from "effect"

/**
 * What a host contributes to generic capability plugins. Tools, skills and
 * prompt sections are DEFINED by the host; registration, discovery, the
 * active set and prompt assembly belong to the plugins that consume them.
 */

export const ToolAnnotations = Schema.Struct({
  /** Read-only tools share a concurrency lane; others run exclusively. */
  readOnly: Schema.Boolean,
  /** Repeat calls with unchanged results are expected (never "degenerate"). */
  pollable: Schema.Boolean,
  /** The result survives every compaction verbatim. */
  pinned: Schema.Boolean,
  /** Grants the run must hold for the tool to be callable. */
  permissions: Schema.Array(Schema.String),
  maxCallsPerRun: Schema.OptionFromNullOr(Schema.Int),
  /** Host display metadata, carried on invocation events. */
  labels: Schema.Record(Schema.String, Schema.String),
  stage: Schema.OptionFromNullOr(Schema.String),
})
export type ToolAnnotations = typeof ToolAnnotations.Type

/** Tier 3: reference material a loaded skill may read on demand. */
export const SkillReference = Schema.Struct({
  id: Schema.Trimmed.check(Schema.isNonEmpty()),
  title: Schema.Trimmed.check(Schema.isNonEmpty()),
  text: Schema.String,
})
export type SkillReference = typeof SkillReference.Type

export const SkillDefinition = Schema.Struct({
  id: Schema.Trimmed.check(Schema.isNonEmpty()),
  version: Schema.Trimmed.check(Schema.isNonEmpty()),
  /** Tier 1: one line in the catalogue, always in context. */
  summary: Schema.Trimmed.check(Schema.isNonEmpty()),
  /** Tier 2: returned by load_skill together with the skill's tools. */
  instructions: Schema.String,
  tools: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())),
  /** Active from the first step of every turn. */
  always: Schema.Boolean,
  permissions: Schema.Array(Schema.String),
  references: Schema.Array(SkillReference),
})
export type SkillDefinition = typeof SkillDefinition.Type

export const PromptTier = Schema.Literals(["static", "session", "turn"])
export type PromptTier = typeof PromptTier.Type

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
