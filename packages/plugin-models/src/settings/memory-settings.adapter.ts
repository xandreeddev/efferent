import { Effect, Layer, SynchronizedRef } from "effect"
import { EngineSettings, SettingsStore } from "../ports/settings-store.port.js"
import { applyRole, applySetting } from "./settings-value.entity.functions.js"

/**
 * `MemorySettingsStoreLive(initial)` — a SettingsStore that never touches
 * disk: one writable value for the layer's lifetime, starting at `initial`.
 * `setRole` and `set` check their value the way the file store does
 * (a `"<provider>:<modelId>"` selection; each key's string form) and refuse
 * one that does not parse, leaving the settings as they were.
 *
 * @public
 */
export const MemorySettingsStoreLive = (initial: EngineSettings = new EngineSettings({})): Layer.Layer<SettingsStore> =>
  Layer.effect(SettingsStore, Effect.gen(function* () {
    const state = yield* SynchronizedRef.make(initial)
    return SettingsStore.of({
      load: SynchronizedRef.get(state),
      setRole: (role, selection) => SynchronizedRef.updateEffect(state, (settings) => applyRole(settings, role, selection)),
      set: (key, value) => SynchronizedRef.updateEffect(state, (settings) => applySetting(settings, key, value)),
    })
  }))
