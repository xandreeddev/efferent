import { EmbeddingModel } from "effect/ai"
import { Layer } from "effect"
import { BackgroundWorkers, Capabilities, LongTermMemory, MemoryStore, UtilityLlm, definePlugin } from "@xandreed/core"
import { memoryCapability } from "./memory-capability.adapter.js"
import { MemoryLive } from "./memory-engine.adapter.js"
import { MemoryConfig, memoryDefaults } from "./memory.entity.js"

/** Native evidence-backed memory with temporal graph reconciliation and durable background processing. @public */
export const memoryPlugin = definePlugin({
  id: "@xandreed/plugin-memory", version: "0.22.0", scope: "runtime",
  config: MemoryConfig, defaults: memoryDefaults,
  requires: [MemoryStore, UtilityLlm, EmbeddingModel.EmbeddingModel],
  provides: [LongTermMemory], contributes: [Capabilities, BackgroundWorkers],
  layer: (config) => Layer.merge(MemoryLive(config), Layer.succeed(Capabilities, [memoryCapability(config)])),
})
/** @public */
export const MemoryPluginLive = memoryPlugin.live
export default memoryPlugin
