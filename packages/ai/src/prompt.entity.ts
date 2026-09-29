import { Schema } from "effect"
import type { Option } from "effect"
import type { Prompt } from "effect/ai"
import type { PromptId, PromptProvenance } from "@xandreed/core"

/** A variant's name: no `@` (it separates an encoded target) and no whitespace. */
export const VariantName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[^@\s]+$/)))

/** Which model a prompt is rendered for, and which of its variants. */
export const ModelTarget = Schema.Struct({
  /** `provider/model`, or `unknown`. */
  model: Schema.Trimmed.check(Schema.isNonEmpty()),
  variant: VariantName,
})
export type ModelTarget = typeof ModelTarget.Type

/**
 * One variant's fragments. The most specific one applies: the target's
 * model, else its provider (the part of the model before `/`), else the
 * shared fragment.
 */
export interface Variant<F> {
  readonly shared: F
  readonly providers?: Readonly<Record<string, F>>
  readonly models?: Readonly<Record<string, F>>
}

/** A prompt's variants by name (`baseline`, `concise`, …). */
export type Variants<F> = Readonly<Record<string, Variant<F>>>

/** The fragment a target selects, and the override key that chose it (a model or a provider; None for shared). */
export interface SelectedVariant<F> {
  readonly fragment: F
  readonly override: Option.Option<string>
}

/** A structured output a prompt asks for. */
export interface PromptOutput<O, OI> {
  readonly name: Option.Option<string>
  readonly schema: Schema.Codec<O, OI>
}

/**
 * A prompt with an identity: rendered from its input into a native
 * @effect/ai Prompt, composed with the variant fragment its target selects,
 * and recorded with its provenance (id, version, variant, override, hash).
 */
export interface VersionedPrompt<I, O = never, OI extends Record<string, unknown> = never> {
  readonly _tag: "VersionedPrompt"
  readonly id: typeof PromptId.Type
  readonly version: string
  readonly render: (input: I) => Prompt.Prompt
  readonly variants: Option.Option<Variants<Prompt.Prompt>>
  readonly output: Option.Option<(input: I) => PromptOutput<O, OI>>
}

/** A prompt as sent: the composed messages, their provenance, and the output they ask for. */
export interface RenderedPrompt<O = never, OI = never> {
  readonly prompt: Prompt.Prompt
  readonly provenance: PromptProvenance
  readonly output: Option.Option<PromptOutput<O, OI>>
}

export class PromptError extends Schema.TaggedError<PromptError>()("PromptError", {
  code: Schema.Literals(["variant.unknown", "variant.invalid", "output.missing", "hash.failed"]),
  message: Schema.String,
}) {}
