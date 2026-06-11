import { AiError, LanguageModel } from "@effect/ai"
import { FetchHttpClient, HttpClient } from "@effect/platform"
import {
  AuthStore,
  LlmInfo,
  ModelOverrideRef,
  ModelRegistry,
  SettingsStore,
  type ModelSelection,
} from "@efferent/core"
import { Effect, FiberRef, Layer, Stream } from "effect"
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
        // A resolveKey FAILURE is a failed OAuth refresh — surface it (the
        // error says "run :login <provider> again"); masking it as "no
        // credential" reads as the model silently vanishing. The error is a
        // real AiError at runtime (rendered by every mode's failure path);
        // statically it's erased — `ExtractError<Options>` is a generic this
        // signature can't widen (same cast class as `prependClaudeCode`).
        const key = yield* authStore
          .resolveKey(sel.provider)
          .pipe(
            Effect.mapError(
              (e) =>
                new AiError.UnknownError({
                  module: "Router",
                  method: "resolveKey",
                  description: e.message,
                }) as never,
            ),
          )
        const settings = yield* settingsStore.get()
        return yield* makeProviderLanguageModel(sel, key, cred, settings)
      })

    // The selection for THIS call: a fiber-local override (a sub-agent running
    // on the FAST tier) wins; otherwise the live main selection. Read per call
    // so `:model` and `run_agent` tiering both apply with no rebuild.
    const currentSelection = FiberRef.get(ModelOverrideRef).pipe(
      Effect.flatMap((override) =>
        override !== undefined ? Effect.succeed(override) : registry.current,
      ),
    )

    const service: LanguageModel.Service = {
      generateText: (options) =>
        currentSelection.pipe(
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
        currentSelection.pipe(
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
          currentSelection.pipe(
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
