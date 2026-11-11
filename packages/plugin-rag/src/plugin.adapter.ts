import { EmbeddingModel } from "effect/ai"
import { Capabilities, BackgroundWorkers, definePlugin, Knowledge, KnowledgeStore, UtilityLlm } from "@xandreed/core"
import { Layer } from "effect"
import { ragCapability } from "./rag-capability.adapter.js"
import { RagLive } from "./rag-engine.adapter.js"
import { RagConfig, ragDefaults } from "./rag.entity.js"

/** Native document ingestion, hybrid retrieval, cited tools and optional GraphRAG. @public */
export const ragPlugin = definePlugin({
  id: "@xandreed/plugin-rag", version: "0.21.2", scope: "runtime", config: RagConfig, defaults: ragDefaults,
  requires: [KnowledgeStore, EmbeddingModel.EmbeddingModel], optional: [UtilityLlm], provides: [Knowledge], contributes: [BackgroundWorkers, Capabilities],
  layer: (config) => Layer.mergeAll(RagLive(config), Layer.succeed(Capabilities, [ragCapability(config)])),
})
/** Typed plugin layer; UtilityLlm is needed only when graph extraction is enabled. @public */
export const RagPluginLive = ragPlugin.live
export default ragPlugin
