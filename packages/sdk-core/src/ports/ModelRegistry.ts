import { Context, Data, type Effect } from "effect"
import type { ModelInfo, ModelSelection, Provider } from "../entities/Model.js"
import type { ConfigScope } from "./SettingsStore.js"

/** Listing the live model catalogue failed (network / auth / parse). */
export class ModelListError extends Data.TaggedError("ModelListError")<{
  readonly provider: Provider
  readonly message: string
}> {}

/**
 * The runtime model selection + live catalogue. The router `LanguageModel`
 * adapter reads `current` on every turn to pick its provider; the TUI's
 * `/model` command uses `list` (live-fetched, key-gated, chat-capable only)
 * to offer choices and `select` to switch + persist.
 *
 * The selection is the single source of truth in `SettingsStore` (persisted
 * to `.efferent/config.json` as `"<provider>:<modelId>"`), so `current` always
 * reflects the latest `/model` switch without a separate cache to keep in
 * sync.
 */
export class ModelRegistry extends Context.Tag("@xandreed/sdk-core/ModelRegistry")<
  ModelRegistry,
  {
    /** The model the loop should use right now. */
    readonly current: Effect.Effect<ModelSelection>
    /**
     * Live, chat/tool-capable models for every provider whose API key is
     * configured. Embeddings/audio/image models are filtered out.
     */
    readonly list: Effect.Effect<ReadonlyArray<ModelInfo>, ModelListError>
    /** Switch the active model and persist the choice to the given config tier
     *  (default `"local"`). Returns the new selection. */
    readonly select: (
      info: {
        readonly provider: Provider
        readonly modelId: string
        readonly contextWindow?: number
      },
      scope?: ConfigScope,
    ) => Effect.Effect<ModelSelection>
  }
>() {}
