import { Schema } from "effect"

/**
 * What a request tells a model that binds each thinking block to the
 * conversation before it (`ModelProfile.bindsThinking`) to do with a block
 * whose prefix changed: `provider-default` sends nothing and leaves it to
 * the account (an account that enforces the binding refuses the request,
 * one that does not passes the block on); `drop_block` drops that block and
 * the later thinking blocks for the request; `error` refuses the request.
 * Any value but `provider-default` turns the binding on for that request.
 */
export const ThinkingPrefixMismatch = Schema.Literals(["provider-default", "drop_block", "error"])
export type ThinkingPrefixMismatch = typeof ThinkingPrefixMismatch.Type

/** The beta a request needs to carry `thinking.block_binding` (refused without it) and to be told what was dropped. */
export const THINKING_BINDING_BETA = "thinking-binding-controls-2026-08-01"

/** One change the provider made to a request's input before the model read it (`input_transformations`). */
export const InputTransformation = Schema.Struct({
  /** `thinking_dropped`, `thinking_mismatch_allowed`, or another the provider adds later. */
  type: Schema.String,
  /** Why: `prefix_binding_mismatch`, `model_binding_mismatch`, `organization_binding_mismatch`. */
  reason: Schema.optionalKey(Schema.String),
})
export type InputTransformation = typeof InputTransformation.Type

/** What a settled response's body says it changed, its other fields left unread. */
export const TransformedResponse = Schema.Struct({
  input_transformations: Schema.optionalKey(Schema.Array(InputTransformation)),
})

/** A stream's `message_start` event: its message carries the changes (the event itself too, read either way). */
export const TransformedMessageStart = Schema.Struct({
  type: Schema.Literal("message_start"),
  input_transformations: Schema.optionalKey(Schema.Array(InputTransformation)),
  message: Schema.optionalKey(TransformedResponse),
})
