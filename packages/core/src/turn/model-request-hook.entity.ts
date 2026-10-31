import { Schema } from "effect"
import { RunRef } from "../domain/run.entity.js"
import { ToolChoice } from "../domain/tool-choice.entity.js"

/** Immutable logical controls before one fresh turn request is prepared. @public */
export const ModelRequestDraft = Schema.Struct({
  run: RunRef,
  step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  activeTools: Schema.Array(Schema.String),
  system: Schema.String,
  context: Schema.OptionFromNullOr(Schema.String),
  toolChoice: Schema.OptionFromNullOr(ToolChoice),
})
export type ModelRequestDraft = typeof ModelRequestDraft.Type

/** Missing fields keep policy controls; null tool choice clears it to automatic. @public */
export const ModelRequestPatch = Schema.Struct({
  system: Schema.optionalKey(Schema.String),
  context: Schema.optionalKey(Schema.String),
  toolChoice: Schema.optionalKey(Schema.NullOr(ToolChoice)),
})
export type ModelRequestPatch = typeof ModelRequestPatch.Type

/** Effective controls plus the normalized accepted patch, absent when no hook ran. @public */
export const ModelRequestPreparation = Schema.Struct({
  system: Schema.String,
  context: Schema.OptionFromNullOr(Schema.String),
  toolChoice: Schema.OptionFromNullOr(ToolChoice),
  hook: Schema.OptionFromNullOr(ModelRequestPatch),
})
export type ModelRequestPreparation = typeof ModelRequestPreparation.Type
