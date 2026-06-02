import { LanguageModel } from "@effect/ai"
import { GoogleClient, GoogleLanguageModel } from "@effect/ai-google"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai"
import { FetchHttpClient } from "@effect/platform"
import { LlmInfo, ModelRegistry, type ModelSelection } from "@efferent/core"
import { Effect, Layer, Stream } from "effect"
import { ProviderClientsLive } from "./clients.js"
import { ModelRegistryLive } from "./modelRegistry.js"

/**
 * The single `LanguageModel` the agent loop talks to. It is provider-
 * agnostic: on every call it reads `ModelRegistry.current` and delegates to
 * the chosen provider's `@effect/ai` service, built on the fly from the
 * captured client. Switching model/provider at runtime (via `/model`) needs
 * no rebuild — the next turn just reads the new selection.
 *
 * Caching is aggressive but provider-native:
 *   - **OpenAI**: automatic prompt-prefix caching; we set a stable
 *     `prompt_cache_key` so repeated prefixes route to the same cache.
 *   - **Gemini**: implicit context caching kicks in automatically for a
 *     stable prefix (visible via `cachedContentTokenCount`); explicit
 *     `cachedContent` resources aren't expressible through `@effect/ai-google`
 *     today (it always sends the full `contents`), so we rely on implicit.
 */
export const RouterLanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const google = yield* GoogleClient.GoogleClient
    const openai = yield* OpenAiClient.OpenAiClient
    const registry = yield* ModelRegistry

    const makeFor = (sel: ModelSelection) =>
      sel.provider === "google"
        ? GoogleLanguageModel.make({ model: sel.modelId }).pipe(
            Effect.provideService(GoogleClient.GoogleClient, google),
          )
        : OpenAiLanguageModel.make({
            model: sel.modelId,
            config: { prompt_cache_key: "agent" },
          }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, openai))

    const service: LanguageModel.Service = {
      generateText: (options) =>
        registry.current.pipe(
          Effect.flatMap(makeFor),
          Effect.flatMap((svc) => svc.generateText(options)),
        ),
      streamText: (options) =>
        Stream.unwrap(
          registry.current.pipe(
            Effect.flatMap(makeFor),
            Effect.map((svc) => svc.streamText(options)),
          ),
        ),
      generateObject: (options) =>
        registry.current.pipe(
          Effect.flatMap(makeFor),
          Effect.flatMap((svc) => svc.generateObject(options)),
        ),
    }
    return service
  }),
)

/** Status-bar metadata follows the live selection (model id + window). */
export const LlmInfoLive = Layer.effect(
  LlmInfo,
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    return {
      metadata: registry.current.pipe(
        Effect.map((sel) => ({
          modelId: sel.modelId,
          contextWindow: sel.contextWindow,
        })),
      ),
    }
  }),
)

/**
 * The complete model tier: the router `LanguageModel`, the live
 * `ModelRegistry`, and the dynamic `LlmInfo`. Requires only `SettingsStore`
 * (the selection's source of truth); both provider clients are provided
 * internally. Replaces the old single-provider `GoogleLive`.
 */
export const ModelLive = Layer.mergeAll(RouterLanguageModelLive, LlmInfoLive)
  .pipe(
    Layer.provideMerge(
      ModelRegistryLive.pipe(Layer.provide(FetchHttpClient.layer)),
    ),
  )
  .pipe(Layer.provide(ProviderClientsLive))
