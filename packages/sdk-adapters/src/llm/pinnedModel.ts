import type { LanguageModel } from "@effect/ai"
import { HttpClient } from "@effect/platform"
import { AuthStore, type ModelSelection, SettingsStore } from "@xandreed/sdk-core"
import { Effect, type Scope } from "effect"
import { makeProviderLanguageModel } from "./providers.js"

/**
 * Build a `LanguageModel.Service` pinned to ONE explicit selection — NOT
 * role/registry-driven like the router. Resolves the key from the `AuthStore`
 * and builds the provider client. For one-shot, off-router helpers that must
 * target a specific model regardless of the loop's settings — notably the eval
 * **judge**, which has to be a STRONG, INDEPENDENT grader (a different model from
 * the one under test) to avoid self-preference bias. Scoped: the provider client
 * lives for the caller's `Scope` (e.g. a `Layer.scoped` lifetime).
 */
export const makePinnedModel = (
  sel: ModelSelection,
): Effect.Effect<
  LanguageModel.Service,
  unknown,
  AuthStore | SettingsStore | HttpClient.HttpClient | Scope.Scope
> =>
  Effect.gen(function* () {
    const auth = yield* AuthStore
    const cred = yield* auth.get(sel.provider)
    const key = yield* auth.resolveKey(sel.provider)
    const settings = yield* (yield* SettingsStore).get()
    const { svc } = yield* makeProviderLanguageModel(sel, key, cred, settings)
    return svc
  })
