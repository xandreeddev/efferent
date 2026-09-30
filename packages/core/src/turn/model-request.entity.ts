import { Schema } from "effect"
import { ModelCallPolicy } from "../domain/model-call-policy.entity.js"

/** Public provider options only. Credentials and endpoint authorization never belong here. */
export const ModelRequestDescriptor = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  settings: Schema.Record(Schema.String, Schema.Unknown),
})
export type ModelRequestDescriptor = typeof ModelRequestDescriptor.Type

/** The model-visible declaration, including provider-defined tools' configuration. */
export const ModelRequestTool = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
  provider: Schema.OptionFromNullOr(Schema.Struct({ id: Schema.String, name: Schema.String, args: Schema.Unknown })),
})
export type ModelRequestTool = typeof ModelRequestTool.Type

/** A saved pure-render recipe: replay uses these options even after a memory plugin upgrade. */
export const MemoryRenderRecipe = Schema.Struct({
  strategy: Schema.String,
  currentTurn: Schema.Int,
  currentRun: Schema.String,
  turnContext: Schema.Literals(["current", "all"]),
  replies: Schema.Boolean,
  stepContext: Schema.Literals(["tail", "none"]),
  digests: Schema.Boolean,
  media: Schema.Struct({ mode: Schema.Literals(["none", "inline"]), maxImages: Schema.Int }),
})
export type MemoryRenderRecipe = typeof MemoryRenderRecipe.Type

/** Durable protocol, separate from diagnostic context/model events. Messages remain in memory events. */
export const ModelRequestHeader = Schema.Struct({
  version: Schema.Literal(1),
  runId: Schema.String,
  step: Schema.Int,
  strategyVersion: Schema.String,
  system: Schema.String,
  render: MemoryRenderRecipe,
  contextFingerprint: Schema.String,
  tools: Schema.Array(ModelRequestTool),
  toolChoice: Schema.Unknown,
  /** None explicitly marks an opaque model whose provider configuration cannot be inspected. */
  model: Schema.OptionFromNullOr(ModelRequestDescriptor),
  cacheKey: Schema.OptionFromNullOr(Schema.String),
  callPolicy: Schema.OptionFromNullOr(ModelCallPolicy),
})
export type ModelRequestHeader = typeof ModelRequestHeader.Type
