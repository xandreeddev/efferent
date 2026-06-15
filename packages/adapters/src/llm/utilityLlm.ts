import { Prompt } from "@effect/ai"
import { HttpClient } from "@effect/platform"
import {
  AuthStore,
  extractUsage,
  ModelRegistry,
  modelForRole,
  roleIsConfigured,
  selectionFromString,
  SettingsStore,
  UtilityLlm,
  UtilityLlmError,
  type ModelSelection,
  type UtilityCompletion,
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
 * the requested helper role's selection — `Settings.fastModel` when
 * configured, else the CURRENT main selection (`ModelRegistry.current`) so
 * the capability works with zero configuration — resolve the key from the
 * `AuthStore` (refreshing OAuth like any other call), and build the
 * provider's `LanguageModel` scoped to exactly this one `generateText`. A
 * `:set fastModel …` or `:login` mid-session takes effect on the next call,
 * no rebuild — the same liveness contract as the chat router. Usage comes
 * back with the text so helper spend is countable.
 */
export const UtilityLlmLive = Layer.effect(
  UtilityLlm,
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const settingsStore = yield* SettingsStore
    const registry = yield* ModelRegistry
    const http = yield* HttpClient.HttpClient

    const complete = (
      prompt: string,
      options?: { readonly role?: "fast" },
    ): Effect.Effect<UtilityCompletion, UtilityLlmError> =>
      Effect.gen(function* () {
        const role = options?.role ?? "fast"
        const settings = yield* settingsStore.get()
        const sel: ModelSelection = roleIsConfigured(settings, role)
          ? selectionFromString(modelForRole(settings, role))
          : yield* registry.current
        const cred = yield* auth.get(sel.provider)
        const key = yield* auth.resolveKey(sel.provider)
        const { svc, prependClaudeCode: shouldPrepend } =
          yield* makeProviderLanguageModel(sel, key, cred, settings)
        const request = {
          prompt: Prompt.make([{ role: "user", content: prompt }] as never),
        }
        const res = yield* svc.generateText(
          shouldPrepend ? (prependClaudeCode(request) as typeof request) : request,
        )
        const usage = extractUsage(res.usage, res.content)
        return {
          text: res.text,
          ...(usage.totalTokens > 0 || usage.outputTokens > 0 ? { usage } : {}),
        }
      }).pipe(
        Effect.scoped,
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.mapError((e) => new UtilityLlmError({ message: errorMessage(e) })),
      )

    return { complete }
  }),
)
