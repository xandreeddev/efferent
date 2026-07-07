import { AiError, LanguageModel } from "@effect/ai"
import { FetchHttpClient, HttpClient } from "@effect/platform"
import { Effect, Layer, Option, Stream } from "effect"
import {
  AuthStore,
  formatModelSelection,
  parseModelSelection,
  SettingsStore,
} from "@xandreed/engine"
import type { ModelSelection } from "@xandreed/engine"
import { buildProvider, prependClaudeCode, withAnthropicCacheBreakpoints } from "./providers.js"
import { rejectEmptyResponse, retryableLlm } from "./retry.js"

/**
 * The routed `LanguageModel`: every call re-reads the settings selection and
 * resolves a key from the `AuthStore`, builds the provider's service for
 * exactly that call (`Effect.scoped`), and delegates — so a model switch or a
 * fresh login applies on the next turn with no rebuild. Each call rides the
 * timeout + transient-retry + empty-response guards from `retry.ts`.
 */

const configError = (message: string): AiError.UnknownError =>
  new AiError.UnknownError({ module: "Router", method: "selection", description: message })

const shapeOptions = (
  selection: ModelSelection,
  shouldPrependClaudeCode: boolean,
  options: unknown,
): unknown => {
  const cached =
    selection.provider === "anthropic" ? withAnthropicCacheBreakpoints(options) : options
  return shouldPrependClaudeCode ? prependClaudeCode(cached) : cached
}

/** Resolve the general-role selection from settings. */
const currentSelection = Effect.gen(function* () {
  const settings = yield* SettingsStore
  const loaded = yield* settings.load.pipe(
    Effect.mapError((e) => configError(`settings load failed: ${e.message}`)),
  )
  const raw = Option.getOrElse(loaded.model, () => "")
  return yield* Option.match(parseModelSelection(raw), {
    onNone: () =>
      Effect.fail(
        configError(
          raw.length === 0
            ? `no model configured — set "model": "<provider>:<modelId>" in .efferent/config.json`
            : `the configured model "${raw}" is not a "<provider>:<modelId>" selection`,
        ),
      ),
    onSome: Effect.succeed,
  })
})

/** Build + call one provider generateText for an explicit selection. */
export const generateWith = (
  selection: ModelSelection,
  options: unknown,
): Effect.Effect<
  { readonly content: ReadonlyArray<unknown>; readonly usage: unknown },
  unknown,
  AuthStore | HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const label = formatModelSelection(selection)
    const credential = Option.getOrUndefined(yield* auth.get(selection.provider))
    const key = Option.getOrUndefined(yield* auth.resolveKey(selection.provider))
    const built = yield* buildProvider(selection, credential, key)
    return yield* (
      built.svc.generateText(
        shapeOptions(selection, built.prependClaudeCode, options) as never,
      ) as Effect.Effect<{
        readonly content: ReadonlyArray<unknown>
        readonly usage: unknown
      }>
    ).pipe(
      rejectEmptyResponse(label),
      retryableLlm(label),
      Effect.withSpan("providers.generate", {
        attributes: { "llm.model": label },
      }),
    )
  }).pipe(Effect.scoped)

/**
 * `LanguageModelLive` — the engine loop's `LanguageModel`, routed per call.
 * Requires `SettingsStore` + `AuthStore`; brings its own fetch-backed
 * `HttpClient` so drivers don't have to.
 */
export const LanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const context = yield* Effect.context<AuthStore | SettingsStore>()
    const http = yield* HttpClient.HttpClient

    const service: LanguageModel.Service = {
      generateText: (options) =>
        currentSelection.pipe(
          Effect.flatMap((selection) => generateWith(selection, options)),
          Effect.provide(context),
          Effect.provideService(HttpClient.HttpClient, http),
        ) as never,
      generateObject: (() =>
        Effect.fail(
          configError("generateObject is not wired on the new line yet"),
        )) as never,
      streamText: (() =>
        Stream.fail(
          configError("streamText is not wired on the new line yet — use generateText"),
        )) as never,
    }
    return service
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
