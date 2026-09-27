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
  labels: Schema.Record({ key: Schema.String, value: Schema.String }),
  stage: Schema.OptionFromNullOr(Schema.String),
})
export type ToolAnnotations = typeof ToolAnnotations.Type

/** Tier 3: reference material a loaded skill may read on demand. */
export const SkillReference = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  title: Schema.NonEmptyTrimmedString,
  text: Schema.String,
})
export type SkillReference = typeof SkillReference.Type

export const SkillDefinition = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  version: Schema.NonEmptyTrimmedString,
  /** Tier 1: one line in the catalogue, always in context. */
  summary: Schema.NonEmptyTrimmedString,
  /** Tier 2: returned by load_skill together with the skill's tools. */
  instructions: Schema.String,
  tools: Schema.Array(Schema.NonEmptyTrimmedString),
  /** Active from the first step of every turn. */
  always: Schema.Boolean,
  permissions: Schema.Array(Schema.String),
  references: Schema.Array(SkillReference),
})
export type SkillDefinition = typeof SkillDefinition.Type

export const PromptTier = Schema.Literal("static", "session", "turn")
export type PromptTier = typeof PromptTier.Type
