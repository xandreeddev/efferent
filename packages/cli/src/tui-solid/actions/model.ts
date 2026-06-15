import { batch } from "solid-js"
import { Effect } from "effect"
import { modelForRole, ModelRegistry, SettingsStore, type ModelInfo } from "@efferent/core"
import { openSelect, type SelectOption } from "../presentation/selectBox.js"
import { rolesChip } from "../presentation/statusBar.js"
import type { TuiStore } from "../state/store.js"

/** The pickable non-main roles (`main` is the plain `:model` path). */
export type PickerRole = "fast" | "cheap"

/**
 * Switch the active model and reflect it in the status bar + side-pane gauge.
 * Lifted from `tui.ts`'s `applyModelSelection`: persist the selection through the
 * `ModelRegistry` (router reads it next turn), recompute the provider's effort
 * setting, and warn once on a cross-provider switch mid-conversation.
 */
export const applyModelSelection = (store: TuiStore, chosen: ModelInfo) =>
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    const prev = yield* registry.current
    const sel = yield* registry.select({
      provider: chosen.provider,
      modelId: chosen.modelId,
      ...(chosen.contextWindow > 0 ? { contextWindow: chosen.contextWindow } : {}),
    })
    const settings = yield* (yield* SettingsStore).get()
    const newEffort =
      sel.provider === "anthropic"
        ? settings.anthropicThinkingEffort
        : sel.provider === "openai"
          ? settings.openAiReasoningEffort
          : sel.provider === "google"
            ? settings.geminiThinkingLevel
            : undefined
    yield* Effect.sync(() =>
      batch(() => {
        store.setStatus({ modelId: sel.modelId, effort: newEffort })
        store.setStats((s) => ({ ...s, contextWindow: sel.contextWindow }))
        store.toast(`switched to ${sel.provider}:${sel.modelId}`)
        if (prev.provider !== sel.provider && store.blocks().some((b) => b.kind === "user")) {
          store.pushBlock({
            kind: "info",
            text: "note: switched provider mid-conversation; if the next turn errors, :clear (Gemini needs its own tool-call history).",
          })
        }
      }),
    )
  })

/**
 * Persist a non-main role's model. `null` = follow main again (clears the
 * key; for cheap, the legacy `utilityModel` alias is retired with it). The
 * status bar's roles chip follows immediately.
 */
export const applyRoleModelSelection = (
  store: TuiStore,
  role: PickerRole,
  chosen: ModelInfo | null,
) =>
  Effect.gen(function* () {
    const settingsStore = yield* SettingsStore
    const key = role === "fast" ? "fastModel" : "cheapModel"
    yield* settingsStore.update((curr) => {
      const next = { ...curr } as Record<string, unknown>
      if (chosen === null) delete next[key]
      else next[key] = `${chosen.provider}:${chosen.modelId}`
      if (key === "cheapModel") delete next["utilityModel"]
      return next as typeof curr
    })
    const updated = yield* settingsStore.get()
    yield* Effect.sync(() => {
      store.setStatus({ roles: rolesChip(updated) })
      store.toast(
        chosen === null
          ? `${role} now follows main`
          : `${role} → ${chosen.provider}:${chosen.modelId}`,
      )
    })
  })

/**
 * Fetch the live catalogue and open the model picker overlay. Logged-out → an
 * info nudge to `:login`; a per-provider list error surfaces on the rail but
 * still opens whatever models resolved. The current model is pre-highlighted.
 *
 * With a `role`, the picker configures that tier instead of main: a leading
 * "default (follow main)" row clears it, and the pre-highlight is the role's
 * resolved selection.
 */
export const openModelPicker = (store: TuiStore, role?: PickerRole) =>
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
    if (models.length === 0) {
      yield* Effect.sync(() =>
        store.pushBlock({
          kind: "info",
          text: "no models available — run :login to add a provider (subscription or API key)",
        }),
      )
      return
    }
    if (role !== undefined) {
      const settings = yield* (yield* SettingsStore).get()
      const configured = role === "fast" ? settings.fastModel : (settings.cheapModel ?? settings.utilityModel)
      const resolved = modelForRole(settings, role)
      const options: ReadonlyArray<SelectOption<ModelInfo | null>> = [
        { value: null, label: "default (follow main)", active: configured === undefined },
        ...models.map((m) => ({
          value: m as ModelInfo | null,
          label: `${m.provider}:${m.modelId}`,
          active: configured !== undefined && `${m.provider}:${m.modelId}` === resolved,
        })),
      ]
      yield* Effect.sync(() =>
        store.setOverlay({
          kind: "select",
          sel: openSelect(`Select the ${role.toUpperCase()} model`, options),
          purpose: { tag: "model", role },
        }),
      )
      return
    }
    const options: ReadonlyArray<SelectOption<ModelInfo>> = models.map((m) => ({
      value: m,
      label: `${m.provider}:${m.modelId}`,
      active: m.provider === cur.provider && m.modelId === cur.modelId,
    }))
    yield* Effect.sync(() =>
      store.setOverlay({ kind: "select", sel: openSelect("Select a model", options), purpose: { tag: "model" } }),
    )
  })
