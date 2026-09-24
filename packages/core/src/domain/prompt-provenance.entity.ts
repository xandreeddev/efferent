import { Schema } from "effect"

export const PromptId = Schema.NonEmptyTrimmedString.pipe(Schema.brand("PromptId"))
/** Metadata accompanies a native @effect/ai Prompt; it never replaces its messages. */
export const PromptProvenance = Schema.Struct({
  id: PromptId,
  version: Schema.NonEmptyTrimmedString,
  variant: Schema.NonEmptyTrimmedString,
  modelOverride: Schema.OptionFromNullOr(Schema.String),
  hash: Schema.NonEmptyTrimmedString,
})
export type PromptProvenance = typeof PromptProvenance.Type
