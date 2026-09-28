import { Schema } from "effect"

export const PromptId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("PromptId"))
/** Metadata accompanies a native @effect/ai Prompt; it never replaces its messages. */
export const PromptProvenance = Schema.Struct({
  id: PromptId,
  version: Schema.Trimmed.check(Schema.isNonEmpty()),
  variant: Schema.Trimmed.check(Schema.isNonEmpty()),
  modelOverride: Schema.OptionFromNullOr(Schema.String),
  hash: Schema.Trimmed.check(Schema.isNonEmpty()),
})
export type PromptProvenance = typeof PromptProvenance.Type
