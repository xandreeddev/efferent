// Provenance stays in core, where model adapters read it; it is re-exported here.
export { CurrentPromptProvenance, PromptId, PromptProvenance } from "@xandreed/core"

// model prompts
export * from "./prompt.entity.js"
export * from "./prompt.entity.functions.js"
export { CurrentModelTarget } from "./ports/model-target.port.js"

// decision prompts
export * from "./decision.entity.js"
export * from "./decision.entity.functions.js"
export { EvaluationModel } from "./ports/evaluation-model.port.js"
export { EvaluationModelLive, makeEvaluationModel, scriptedEvaluationModel } from "./evaluation-model.adapter.js"
export type { EvaluationModelOptions, EvaluationWire } from "./evaluation-model.adapter.js"

// hashing (SHA-256 over Web Crypto)
export { decisionHash, promptHash, sha256Hex } from "./hash.adapter.js"
