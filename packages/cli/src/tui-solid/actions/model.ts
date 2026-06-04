import { batch } from "solid-js"
import { Effect } from "effect"
import { ModelRegistry, SettingsStore, type ModelInfo } from "@efferent/core"
import { openSelect, type SelectOption } from "../presentation/selectBox.js"
import type { TuiStore } from "../state/store.js"

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
        store.setStatus({ modelId: sel.modelId, contextWindow: sel.contextWindow, effort: newEffort })
        store.setSidePane((s) => ({ ...s, stats: { ...s.stats, contextWindow: sel.contextWindow } }))
        store.pushBlock({ kind: "info", text: `switched to ${sel.provider}:${sel.modelId}` })
        if (prev.provider !== sel.provider && store.blocks().some((b) => b.kind === "user")) {
          store.pushBlock({
            kind: "info",
            text: "note: switched provider mid-conversation; if the next turn errors, :reset (Gemini needs its own tool-call history).",
          })
        }
      }),
    )
  })

/**
 * Fetch the live catalogue and open the model picker overlay. Logged-out → an
 * info nudge to `:login`; a per-provider list error surfaces on the rail but
 * still opens whatever models resolved. The current model is pre-highlighted.
 */
export const openModelPicker = (store: TuiStore) =>
  Effect.gen(function* () {
    const registry = yield* ModelRegistry
    yield* Effect.sync(() => store.pushBlock({ kind: "info", text: "fetching models…" }))
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
    const options: ReadonlyArray<SelectOption<ModelInfo>> = models.map((m) => ({
      value: m,
      label: `${m.provider}:${m.modelId}`,
      active: m.provider === cur.provider && m.modelId === cur.modelId,
    }))
    yield* Effect.sync(() =>
      store.setOverlay({ kind: "select", sel: openSelect("Select a model", options), purpose: { tag: "model" } }),
    )
  })
