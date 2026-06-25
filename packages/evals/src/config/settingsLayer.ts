import { Effect, Layer, Ref } from "effect"
import { DefaultSettings, type Settings, SettingsStore } from "@xandreed/sdk-core"
import type { RunConfig } from "./RunConfig.js"

/** Apply a `RunConfig`'s knobs onto a base `Settings` (start from defaults). */
export const settingsFromConfig = (base: Settings, c: RunConfig): Settings => ({
  ...base,
  model: c.main,
  ...(c.fast !== undefined ? { fastModel: c.fast } : {}),
  ...(c.code !== undefined ? { codeModel: c.code } : {}),
  ...(c.maxSteps !== undefined ? { maxSteps: c.maxSteps } : {}),
  ...(c.toolResultMaxTokens !== undefined
    ? { toolResultMaxTokens: c.toolResultMaxTokens }
    : {}),
})

/**
 * A `SettingsStore` pinned to one `Settings` value. `load()` ignores cwd/home
 * and returns the pinned settings, so `EFFERENT_MODEL` / `.efferent/config.json`
 * can NOT override a chosen eval config (the whole point — a config is the
 * fixed independent variable of the run). `update` stays live over a `Ref` so a
 * mid-run `:set`-style change still works if a use case writes one.
 */
export const FixedSettingsStoreLive = (settings: Settings): Layer.Layer<SettingsStore> =>
  Layer.effect(
    SettingsStore,
    Effect.gen(function* () {
      const ref = yield* Ref.make(settings)
      return SettingsStore.of({
        get: () => Ref.get(ref),
        // No tier split in evals — the pinned value is both merged and global.
        global: () => Ref.get(ref),
        update: (f) => Ref.updateAndGet(ref, f),
        load: () => Ref.get(ref),
      })
    }),
  )

/** Convenience: a pinned store built from a `RunConfig` over `DefaultSettings`. */
export const settingsLayerForConfig = (c: RunConfig): Layer.Layer<SettingsStore> =>
  FixedSettingsStoreLive(settingsFromConfig(DefaultSettings, c))
