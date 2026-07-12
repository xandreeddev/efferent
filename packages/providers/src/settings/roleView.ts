import { Effect, Layer, Option } from "effect"
import { EngineSettings, SettingsStore } from "@xandreed/engine"

/**
 * A role-scoped VIEW of the settings store: `load` re-maps the general
 * `model` to the role's selection (falling back to `model` when the role is
 * unset), so any consumer that routes on `settings.model` — the
 * LanguageModel router above all — runs on that role WITHOUT knowing roles
 * exist. Compose it under `LanguageModelLive` for the scope that should use
 * the role (e.g. the forge implementor on "code"); writes pass through.
 */
export const roleModelView = (
  role: "code" | "fast",
): Layer.Layer<SettingsStore, never, SettingsStore> =>
  Layer.effect(
    SettingsStore,
    Effect.map(SettingsStore, (inner) => ({
      load: Effect.map(
        inner.load,
        (s) =>
          new EngineSettings({
            ...s,
            model: Option.orElse(role === "code" ? s.codeModel : s.fastModel, () => s.model),
            reasoningEffort: Option.orElse(
              role === "code" ? s.codeReasoningEffort : s.fastReasoningEffort,
              () => s.reasoningEffort,
            ),
          }),
      ),
      setRole: inner.setRole,
      set: inner.set,
    })),
  )
