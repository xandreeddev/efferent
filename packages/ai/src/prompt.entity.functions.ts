import { LanguageModel, Prompt } from "effect/ai"
import type { AiError } from "effect/ai"
import { Effect, Option } from "effect"
import type { Schema } from "effect"
import { CurrentPromptProvenance, HarnessError, PromptId } from "@xandreed/core"
import type { PromptContext, PromptProvenance, PromptSection, PromptTier } from "@xandreed/core"
import { promptHash } from "./hash.adapter.js"
import { CurrentModelTarget } from "./ports/model-target.port.js"
import { PromptError } from "./prompt.entity.js"
import type { ModelTarget, PromptOutput, RenderedPrompt, SelectedVariant, Variant, Variants, VersionedPrompt } from "./prompt.entity.js"

/** What a prompt renders for when nothing says otherwise. */
export const baselineTarget: ModelTarget = { model: "unknown", variant: "baseline" }

/** The current call's target: the CurrentModelTarget where this runs, else `baselineTarget`. */
export const currentTarget: Effect.Effect<ModelTarget> = Effect.serviceOption(CurrentModelTarget).pipe(
  Effect.map(Option.getOrElse(() => baselineTarget)),
)

const own = <V>(record: Readonly<Record<string, V>> | undefined, key: string): Option.Option<V> =>
  record !== undefined && Object.hasOwn(record, key) ? Option.fromNullishOr(record[key]) : Option.none()

/** The provider of a `provider/model` target. */
export const providerOf = (target: ModelTarget): Option.Option<string> => {
  const slash = target.model.indexOf("/")
  return slash > 0 ? Option.some(target.model.slice(0, slash)) : Option.none()
}

/** A target as the variant string a PromptSection receives: `<variant>@<model>`. */
export const encodeTarget = (target: ModelTarget): string => `${target.variant}@${target.model}`

/** The inverse of `encodeTarget`; a plain variant name targets an unknown model. */
export const decodeTarget = (text: string): ModelTarget => {
  const at = text.indexOf("@")
  return at > 0 && at < text.length - 1 ? { variant: text.slice(0, at), model: text.slice(at + 1) } : { model: "unknown", variant: text }
}

/**
 * The fragment `target` selects: its variant's model fragment, else its
 * provider's, else the shared one. An unknown variant fails.
 */
export const selectVariant = <F>(variants: Variants<F>, target: ModelTarget): Effect.Effect<SelectedVariant<F>, PromptError> =>
  Option.match(own(variants, target.variant), {
    onNone: () => Effect.fail(new PromptError({
      code: "variant.unknown",
      message: `No variant ${target.variant}; the variants are ${Object.keys(variants).join(", ") || "none"}`,
    })),
    onSome: (variant) => Effect.succeed(Option.match(own(variant.models, target.model), {
      onSome: (fragment): SelectedVariant<F> => ({ fragment, override: Option.some(target.model) }),
      onNone: () => Option.getOrElse(
        Option.flatMap(providerOf(target), (provider) => Option.map(own(variant.providers, provider), (fragment): SelectedVariant<F> => ({ fragment, override: Option.some(provider) }))),
        (): SelectedVariant<F> => ({ fragment: variant.shared, override: Option.none() }),
      ),
    })),
  })

/** The base prompt's system messages, then the fragment, then its other messages; an empty fragment changes nothing. */
export const composeVariant = (base: Prompt.Prompt, fragment: Prompt.Prompt): Prompt.Prompt =>
  fragment.content.length === 0 ? base : Prompt.fromMessages([
    ...base.content.filter((message) => message.role === "system"),
    ...fragment.content,
    ...base.content.filter((message) => message.role !== "system"),
  ])

const mapRecord = <A, B>(record: Readonly<Record<string, A>>, f: (value: A) => B): Readonly<Record<string, B>> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, f(value)]))

/** Every fragment of every variant, mapped. */
export const mapVariants = <A, B>(variants: Variants<A>, f: (fragment: A) => B): Variants<B> =>
  mapRecord(variants, (variant: Variant<A>): Variant<B> => ({
    shared: f(variant.shared),
    ...(variant.providers === undefined ? {} : { providers: mapRecord(variant.providers, f) }),
    ...(variant.models === undefined ? {} : { models: mapRecord(variant.models, f) }),
  }))

/**
 * Define a versioned prompt. `render` and the variant fragments take any
 * @effect/ai prompt input (text, messages or a Prompt). `output` makes it a
 * structured prompt for `generateObject`.
 */
export const definePrompt = <I, O = never, OI extends Record<string, unknown> = never>(definition: {
  readonly id: string
  readonly version: string
  readonly render: (input: I) => Prompt.RawInput
  readonly variants?: Variants<Prompt.RawInput>
  readonly output?: (input: I) => { readonly name?: string; readonly schema: Schema.Codec<O, OI> }
}): VersionedPrompt<I, O, OI> => ({
  _tag: "VersionedPrompt",
  id: PromptId.make(definition.id),
  version: definition.version,
  render: (input) => Prompt.make(definition.render(input)),
  variants: Option.map(Option.fromNullishOr(definition.variants), (variants) => mapVariants(variants, Prompt.make)),
  output: Option.map(Option.fromNullishOr(definition.output), (of) => (input: I): PromptOutput<O, OI> => {
    const output = of(input)
    return { name: Option.fromNullishOr(output.name), schema: output.schema }
  }),
})

/**
 * Render a prompt for `target` (default: `currentTarget`): the input's
 * messages composed with the fragment the target selects, and their
 * provenance. The hash is SHA-256 of the composed prompt's encoded form. A
 * prompt without variants accepts any variant.
 */
export const renderPrompt = <I, O, OI extends Record<string, unknown>>(
  prompt: VersionedPrompt<I, O, OI>,
  input: I,
  target?: ModelTarget,
): Effect.Effect<RenderedPrompt<O, OI>, PromptError> => Effect.gen(function* () {
  const resolved = target ?? (yield* currentTarget)
  const selected = yield* Option.match(prompt.variants, {
    onNone: () => Effect.succeed<SelectedVariant<Prompt.Prompt>>({ fragment: Prompt.empty, override: Option.none() }),
    onSome: (variants) => selectVariant(variants, resolved),
  })
  const composed = composeVariant(prompt.render(input), selected.fragment)
  const provenance: PromptProvenance = {
    id: prompt.id,
    version: prompt.version,
    variant: resolved.variant,
    modelOverride: selected.override,
    hash: yield* promptHash(composed),
  }
  return { prompt: composed, provenance, output: Option.map(prompt.output, (of) => of(input)) }
})

/** Run `effect` with this provenance as the CurrentPromptProvenance model adapters read. */
export const withProvenance = (provenance: PromptProvenance) => <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, CurrentPromptProvenance, Option.some(provenance))

/** Render the prompt and generate text with the LanguageModel, under the prompt's provenance. */
export const generateText = <I, O, OI extends Record<string, unknown>>(
  prompt: VersionedPrompt<I, O, OI>,
  input: I,
  options: { readonly target?: ModelTarget } = {},
): Effect.Effect<LanguageModel.GenerateTextResponse<{}>, PromptError | AiError.AiError, LanguageModel.LanguageModel> =>
  renderPrompt(prompt, input, options.target).pipe(Effect.flatMap((rendered) =>
    LanguageModel.generateText({ prompt: rendered.prompt }).pipe(withProvenance(rendered.provenance))))

/** Render the prompt and generate its output with the LanguageModel, under the prompt's provenance. A prompt without an output fails. */
export const generateObject = <I, O, OI extends Record<string, unknown>>(
  prompt: VersionedPrompt<I, O, OI>,
  input: I,
  options: { readonly target?: ModelTarget } = {},
): Effect.Effect<LanguageModel.GenerateObjectResponse<{}, O, "opaque">, PromptError | AiError.AiError, LanguageModel.LanguageModel> => Effect.gen(function* () {
  const rendered = yield* renderPrompt(prompt, input, options.target)
  const output = yield* Option.match(rendered.output, {
    onNone: () => Effect.fail(new PromptError({ code: "output.missing", message: `${prompt.id}@${prompt.version} declares no output` })),
    onSome: (declared) => Effect.succeed(declared),
  })
  return yield* LanguageModel.generateObject({
    prompt: rendered.prompt,
    schema: output.schema,
    ...Option.match(output.name, { onNone: () => ({}), onSome: (objectName) => ({ objectName }) }),
  }).pipe(withProvenance(rendered.provenance))
})

/**
 * A versioned prompt as a system-prompt section: its system messages,
 * rendered for the section's variant string (an `encodeTarget`; without
 * one, `currentTarget`). A prompt error fails the section as
 * `prompt.<code>`.
 */
export const promptSection = <O, OI extends Record<string, unknown>>(
  prompt: VersionedPrompt<PromptContext, O, OI>,
  section: { readonly id: string; readonly version: string; readonly tier: PromptTier; readonly order: number },
): PromptSection => ({
  ...section,
  render: (context) => Effect.gen(function* () {
    const target = yield* Option.match(context.variant, { onNone: () => currentTarget, onSome: (text) => Effect.succeed(decodeTarget(text)) })
    const rendered = yield* renderPrompt(prompt, context, target)
    const text = rendered.prompt.content.flatMap((message) => message.role === "system" ? [message.content] : []).join("\n\n")
    return text.trim().length === 0 ? Option.none() : Option.some(text)
  }).pipe(Effect.mapError((error) => new HarnessError({ code: `prompt.${error.code}`, message: error.message }))),
})
