import { Effect, Layer, Option } from "effect"
import { EngineSettings, SettingsStore } from "@xandreed/engine"
import { LocalSettingsStoreLive } from "@xandreed/providers"
import { SMITH_MODEL_DEFAULTS } from "../domain/SmithConfig.js"
import type { SmithRunConfig } from "../domain/SmithConfig.js"

/**
 * The smith settings overlay on the ENGINE's store, applied to every read.
 * Precedence (highest first): CLI flags > user config
 * (`.efferent/config.json`, local-over-global) > smith model defaults.
 * `setRole` passes through UN-overlaid, so a smith default is never
 * persisted to the user's config.
 */
export const applySmithSettings = (
  merged: EngineSettings,
  run: SmithRunConfig,
): EngineSettings =>
  new EngineSettings({
    ...merged,
    model: Option.orElse(
      Option.orElse(run.models.general, () => merged.model),
      () => Option.some(SMITH_MODEL_DEFAULTS.general),
    ),
    codeModel: Option.orElse(
      Option.orElse(run.models.code, () => merged.codeModel),
      () => Option.some(SMITH_MODEL_DEFAULTS.code),
    ),
    fastModel: Option.orElse(
      Option.orElse(run.models.fast, () => merged.fastModel),
      () => Option.some(SMITH_MODEL_DEFAULTS.fast),
    ),
  })

/** Wrap an inner `SettingsStore` so every read comes back smith-overlaid. */
export const smithSettingsStore = (
  run: SmithRunConfig,
): Layer.Layer<SettingsStore, never, SettingsStore> =>
  Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const inner = yield* SettingsStore
      return {
        load: Effect.map(inner.load, (settings) => applySmithSettings(settings, run)),
        setRole: inner.setRole,
        set: inner.set,
      }
    }),
  )

/** THE `SettingsStore` for a smith composition: the providers store (same
 *  `.efferent/config.json` tiers as everything else) with the smith overlay. */
export const SmithSettingsStoreLive = (run: SmithRunConfig, cwd: string, home: string) =>
  smithSettingsStore(run).pipe(Layer.provide(LocalSettingsStoreLive(cwd, home)))
