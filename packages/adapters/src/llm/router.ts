import { LanguageModel } from "@effect/ai"
import { FetchHttpClient, HttpClient } from "@effect/platform"
import { AuthStore, LlmInfo, ModelRegistry, SettingsStore, type ModelSelection } from "@efferent/core"
import { Effect, Layer, Stream } from "effect"
import { ModelRegistryLive } from "./modelRegistry.js"
import { makeProviderLanguageModel, prependClaudeCode } from "./providers.js"

/**
 * The single `LanguageModel` the agent loop talks to. It is provider-agnostic:
 * on every call it reads `ModelRegistry.current`, resolves a usable credential
 * from `AuthStore`, and delegates to the selected concrete provider adapter.
 *
 * Concrete provider quirks live in sibling adapter modules. The router only
 * handles runtime selection and shared lifecycle/scoping.
 */
export const RouterLanguageModelLive = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    const authStore = yield* AuthStore
    const settingsStore = yield* SettingsStore
    const http = yield* HttpClient.HttpClient

    const resolveAndBuild = (sel: ModelSelection) =>
      Effect.gen(function* () {
        const cred = yield* authStore.get(sel.provider)
        const key = yield* authStore
          .resolveKey(sel.provider)
          .pipe(Effect.orElseSucceed(() => undefined))
        const settings = yield* settingsStore.get()
        return yield* makeProviderLanguageModel(sel, key, cred, settings)
      })

    const service: LanguageModel.Service = {
      generateText: (options) =>
        registry.current.pipe(
          Effect.flatMap((sel) =>
            resolveAndBuild(sel).pipe(
              Effect.flatMap(({ svc, prependClaudeCode: shouldPrepend }) =>
                svc.generateText(
                  shouldPrepend ? (prependClaudeCode(options) as typeof options) : options,
                ),
              ),
            ),
          ),
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, http),
        ),

      generateObject: (options) =>
        registry.current.pipe(
          Effect.flatMap((sel) =>
            resolveAndBuild(sel).pipe(
              Effect.flatMap(({ svc, prependClaudeCode: shouldPrepend }) =>
                svc.generateObject(
                  shouldPrepend ? (prependClaudeCode(options) as typeof options) : options,
                ),
              ),
            ),
          ),
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, http),
        ),

      streamText: (options) =>
        Stream.unwrapScoped(
          registry.current.pipe(
            Effect.flatMap((sel) =>
              resolveAndBuild(sel).pipe(
                Effect.map(({ svc, prependClaudeCode: shouldPrepend }) =>
                  svc.streamText(
                    shouldPrepend ? (prependClaudeCode(options) as typeof options) : options,
                  ),
                ),
              ),
            ),
            Effect.provideService(HttpClient.HttpClient, http),
          ),
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
 * `ModelRegistry`, and the dynamic `LlmInfo`.
 */
export const ModelLive = Layer.mergeAll(RouterLanguageModelLive, LlmInfoLive)
  .pipe(Layer.provideMerge(ModelRegistryLive))
  .pipe(Layer.provide(FetchHttpClient.layer))

/**
 * The platform `HttpClient` layer, re-exported so driver packages that don't
 * depend on `@effect/platform` directly can satisfy HTTP-backed adapters.
 */
export const FetchHttpClientLive = FetchHttpClient.layer
