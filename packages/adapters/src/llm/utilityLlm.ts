import { Prompt } from "@effect/ai"
import { HttpClient } from "@effect/platform"
import {
  AuthStore,
  contextWindowFor,
  ModelRegistry,
  parseModel,
  SettingsStore,
  UtilityLlm,
  UtilityLlmError,
  type ModelSelection,
} from "@efferent/core"
import { Effect, Layer } from "effect"
import { makeProviderLanguageModel, prependClaudeCode } from "./providers.js"

const errorMessage = (e: unknown): string => {
  if (typeof e === "object" && e !== null) {
    const o = e as { message?: unknown; _tag?: unknown; description?: unknown }
    if (typeof o.message === "string" && o.message.length > 0) return o.message
    if (typeof o.description === "string" && o.description.length > 0) return o.description
    if (typeof o._tag === "string") return o._tag
  }
  return String(e)
}

/**
 * `UtilityLlm` over the same per-call provider build as the router: resolve
 * the selection — `Settings.utilityModel` ("<provider>:<modelId>") when set,
 * else the CURRENT chat selection (`ModelRegistry.current`) so the capability
 * works with zero configuration — resolve the key from the `AuthStore`
 * (refreshing OAuth like any other call), and build the provider's
 * `LanguageModel` scoped to exactly this one `generateText`. A `:set
 * utilityModel …` or `:login` mid-session takes effect on the next call, no
 * rebuild — the same liveness contract as the chat router.
 */
export const UtilityLlmLive = Layer.effect(
  UtilityLlm,
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const settingsStore = yield* SettingsStore
    const registry = yield* ModelRegistry
    const http = yield* HttpClient.HttpClient

    const complete = (prompt: string): Effect.Effect<string, UtilityLlmError> =>
      Effect.gen(function* () {
        const settings = yield* settingsStore.get()
        const sel: ModelSelection =
          settings.utilityModel !== undefined
            ? (({ provider, modelId }) => ({
                provider,
                modelId,
                contextWindow: contextWindowFor(provider, modelId),
              }))(parseModel(settings.utilityModel))
            : yield* registry.current
        const cred = yield* auth.get(sel.provider)
        const key = yield* auth.resolveKey(sel.provider)
        const { svc, prependClaudeCode: shouldPrepend } =
          yield* makeProviderLanguageModel(sel, key, cred, settings)
        const options = {
          prompt: Prompt.make([{ role: "user", content: prompt }] as never),
        }
        const res = yield* svc.generateText(
          shouldPrepend ? (prependClaudeCode(options) as typeof options) : options,
        )
        return res.text
      }).pipe(
        Effect.scoped,
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((e) => new UtilityLlmError({ message: errorMessage(e) })),
      )

    return { complete }
  }),
)
