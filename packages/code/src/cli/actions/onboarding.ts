import { Effect } from "effect"
import {
  AuthStore,
  type ConfigScope,
  ModelRegistry,
  SettingsStore,
  type AuthData,
  type ModelInfo,
} from "@xandreed/sdk-core"
import {
  onboardingToLogin,
  onboardingToMainModel,
  onboardingToFastModel,
  onboardingToTheme,
  onboardingToComplete,
  startOnboarding,
  type OnboardingState,
} from "../presentation/onboardingFlow.js"
import { selectedValue } from "../presentation/selectBox.js"
import { type ProviderStatus } from "../presentation/loginFlow.js"
import { rolesChip } from "../presentation/statusBar.js"
import { applyModelSelection } from "./model.js"
import { applyTheme } from "./theme.js"
import type { TuiStore } from "../state/store.js"

const PROVIDERS = ["anthropic", "google", "openai", "opencode", "ollama"] as const

const loginStatuses = (auth: AuthData): ReadonlyArray<ProviderStatus> =>
  PROVIDERS.map((p) => ({ provider: p, configured: auth[p]?.type }))

export const openOnboardingFlow = (store: TuiStore) =>
  Effect.gen(function* () {
    const all = yield* (yield* AuthStore).all
    const statuses = loginStatuses(all)
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: startOnboarding(statuses),
      })
    })
  })

/** scope → login (step 1 → step 2). */
const transitionToLogin = (store: TuiStore, state: OnboardingState) =>
  Effect.sync(() => store.setOverlay({ kind: "onboarding", state: onboardingToLogin(state) }))

export const transitionToMainModel = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    yield* Effect.sync(() => store.toast("fetching models…"))
    const models = yield* registry.list.pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          store.pushBlock({ kind: "error", text: `failed to list ${e.provider} models: ${e.message}` })
          return [] as ReadonlyArray<ModelInfo>
        }),
      ),
    )
    const cur = yield* registry.current
    const currentModelStr = `${cur.provider}:${cur.modelId}`
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: onboardingToMainModel(state, models, currentModelStr),
      })
    })
  })

const transitionToFastModel = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    yield* Effect.sync(() => store.toast("fetching models…"))
    const models = yield* registry.list.pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          store.pushBlock({ kind: "error", text: `failed to list ${e.provider} models: ${e.message}` })
          return [] as ReadonlyArray<ModelInfo>
        }),
      ),
    )
    const settings = yield* (yield* SettingsStore).get()
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: onboardingToFastModel(state, models, settings.fastModel),
      })
    })
  })

const transitionToTheme = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    const settings = yield* (yield* SettingsStore).get()
    const currentTheme = settings.theme ?? "efferent"
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: onboardingToTheme(state, currentTheme),
      })
    })
  })

/** The tier onboarding writes to — the scope chosen in step 1 (stashed on the
 *  run handle), defaulting to global (machine-wide) if somehow unset. */
const onbScope = (store: TuiStore): ConfigScope => store.run.getConfigScope() ?? "global"

export const advanceOnboardingStep = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    switch (state.step) {
      case "scope": {
        const scope = selectedValue(state.sel) ?? "global"
        // Stash the choice so EVERY onboarding write (auth via the login flow,
        // and the settings writes below) lands in the same tier.
        yield* Effect.sync(() => store.run.setConfigScope(scope))
        yield* transitionToLogin(store, state)
        break
      }
      case "login":
        break
      case "mainModel": {
        const selected = selectedValue(state.sel)
        if (selected !== undefined) {
          yield* applyModelSelection(store, selected, onbScope(store))
        }
        yield* transitionToFastModel(store, state)
        break
      }
      case "fastModel": {
        const selected = selectedValue(state.sel) // ModelInfo | null
        const settingsStore = yield* SettingsStore
        yield* settingsStore.update((curr) => {
          if (selected === null || selected === undefined) {
            const { fastModel: _drop, ...rest } = curr
            return rest
          }
          return { ...curr, fastModel: `${selected.provider}:${selected.modelId}` }
        }, onbScope(store))
        const nextSettings = yield* settingsStore.get()
        yield* Effect.sync(() => store.setStatus({ roles: rolesChip(nextSettings) }))
        yield* transitionToTheme(store, state)
        break
      }
      case "theme": {
        const selected = selectedValue(state.sel)
        if (selected !== undefined) {
          yield* applyTheme(store, selected, onbScope(store))
        }
        yield* Effect.sync(() => {
          store.setOverlay({
            kind: "onboarding",
            state: onboardingToComplete(state),
          })
        })
        break
      }
      case "complete":
        yield* finishOnboarding(store)
        break
    }
  })

export const skipToFastModel = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    yield* transitionToFastModel(store, state)
  })

export const skipToTheme = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    yield* transitionToTheme(store, state)
  })

export const skipToComplete = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    yield* Effect.sync(() => {
      store.setOverlay({
        kind: "onboarding",
        state: onboardingToComplete(state),
      })
    })
  })

/**
 * Step BACK one screen (agy-style Esc = Go Back). Each prior step is rebuilt by
 * its transition (the selects re-fetch from the registry), so back-nav reuses
 * the same builders as forward-nav. From `mainModel` we return to the login
 * picker (a fresh `startOnboarding` at the authMethod step); the caller handles
 * `login`'s own back/exit semantics.
 */
export const onboardingBack = (store: TuiStore, state: OnboardingState) =>
  Effect.gen(function* () {
    switch (state.step) {
      case "mainModel":
        // Back to the login step (step 2), not the scope picker.
        yield* transitionToLogin(store, state)
        break
      case "fastModel":
        yield* transitionToMainModel(store, state)
        break
      case "theme":
        yield* transitionToFastModel(store, state)
        break
      case "complete":
        yield* transitionToTheme(store, state)
        break
      case "scope":
      case "login":
        break
    }
  })

export const finishOnboarding = (store: TuiStore) =>
  Effect.gen(function* () {
    const settingsStore = yield* SettingsStore
    yield* settingsStore.update((curr) => ({ ...curr, onboarded: true }), onbScope(store))
    // Onboarding is over — runtime writes revert to their own defaults
    // (auth → global, settings → local).
    yield* Effect.sync(() => store.run.setConfigScope(undefined))
    yield* Effect.sync(() => {
      store.closeOverlay()
      store.pushBlock({
        kind: "info",
        text: "✓ Onboarding completed! Type to chat, or run :settings to adjust preferences.",
      })
    })
  })
