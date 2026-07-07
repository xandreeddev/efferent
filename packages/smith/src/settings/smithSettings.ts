import { Effect, Layer, Option } from "effect"
import { DefaultSettings, SettingsStore } from "@xandreed/sdk-core"
import type { Settings } from "@xandreed/sdk-core"
import { LocalSettingsStoreLive } from "@xandreed/sdk-adapters"
import { SMITH_MODEL_DEFAULTS, SMITH_SETTING_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"

/**
 * The smith settings overlay, applied to every READ of the store. Precedence
 * (highest first): CLI flags > user config (`.efferent/config.json`
 * local-over-global, incl. `EFFERENT_MODEL`) > smith defaults > the stock
 * `DefaultSettings`.
 *
 * Optional keys are precise — `undefined` means the user never set them, so
 * the smith default applies. The required keys (`model`, `maxSteps`) use a
 * sentinel comparison against `DefaultSettings`: a merged value still equal to
 * the stock default means "never configured" (documented edge: explicitly
 * choosing the stock default is indistinguishable — a flag wins regardless).
 */
export const applySmithSettings = (merged: Settings, run: SmithRunConfig): Settings => ({
  ...merged,
  model: Option.getOrElse(run.models.general, () =>
    merged.model === DefaultSettings.model ? SMITH_MODEL_DEFAULTS.general : merged.model,
  ),
  codeModel: Option.getOrElse(
    run.models.code,
    () => merged.codeModel ?? SMITH_MODEL_DEFAULTS.code,
  ),
  fastModel: Option.getOrElse(
    run.models.fast,
    () => merged.fastModel ?? SMITH_MODEL_DEFAULTS.fast,
  ),
  openCodeThinkingMode:
    merged.openCodeThinkingMode ?? SMITH_SETTING_DEFAULTS.openCodeThinkingMode,
  agentMode: merged.agentMode ?? SMITH_SETTING_DEFAULTS.agentMode,
  maxSteps:
    merged.maxSteps === DefaultSettings.maxSteps
      ? SMITH_SETTING_DEFAULTS.maxSteps
      : merged.maxSteps,
  subAgentMaxChildren:
    merged.subAgentMaxChildren ?? SMITH_SETTING_DEFAULTS.subAgentMaxChildren,
  subAgentMaxDepth: merged.subAgentMaxDepth ?? SMITH_SETTING_DEFAULTS.subAgentMaxDepth,
  allowBash: merged.allowBash || run.allowBash,
})

/**
 * Wrap an inner `SettingsStore` so every read comes back smith-overlaid.
 * `update` passes `f` through to the inner store UN-overlaid: the inner diff
 * (`f(prev)` vs `prev`) then only contains the keys `f` itself changed, so a
 * smith default is NEVER persisted to the user's config.json — setter-style
 * updates (`:set k v`) behave identically either way.
 */
export const smithSettingsStore = (
  run: SmithRunConfig,
): Layer.Layer<SettingsStore, never, SettingsStore> =>
  Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const inner = yield* SettingsStore
      const overlay = (settings: Settings) => applySmithSettings(settings, run)
      return SettingsStore.of({
        get: () => Effect.map(inner.get(), overlay),
        global: () => Effect.map(inner.global(), overlay),
        update: (f, scope) => Effect.map(inner.update(f, scope), overlay),
        load: (cwd, homeDir) => Effect.map(inner.load(cwd, homeDir), overlay),
      })
    }),
  )

/**
 * THE `SettingsStore` for a smith composition: the real
 * `LocalSettingsStoreLive` (same `.efferent/config.json` tiers as the
 * efferent CLI) with the smith overlay on top. Requires `FileSystem`.
 */
export const SmithSettingsStoreLive = (run: SmithRunConfig) =>
  smithSettingsStore(run).pipe(Layer.provide(LocalSettingsStoreLive))
