import { FiberRef } from "effect"
import type { ModelSelection } from "../entities/Model.js"

/**
 * Ambient per-fiber model override — how a sub-agent runs on the **fast** tier
 * while the root loop stays on **main**, with one provider-agnostic
 * `LanguageModel` for everyone. The adapters' router consults this on every
 * call: set → use it; unset → `ModelRegistry.current` (the main selection).
 *
 * `runSpawnedAgent` sets it via `Effect.locally` around the child loop, so the
 * override scopes exactly to that sub-agent's fiber (and its children — nested
 * spawns inherit it). The root conversation, the human's composer, and the
 * status bar never see it.
 */
export const ModelOverrideRef: FiberRef.FiberRef<ModelSelection | undefined> =
  FiberRef.unsafeMake<ModelSelection | undefined>(undefined)
