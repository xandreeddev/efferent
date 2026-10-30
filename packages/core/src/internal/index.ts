// `@xandreed/core/internal`: what the agent loop, the models plugin and the
// sdk share with core, with no semver: the provider mapping, the stream fold
// and tool schemas. Imported by first-party packages only.
export {
  extractUsage,
  handoffToMessage,
  responseReasoning,
  responseText,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
  safeKeepFrom,
  toPromptMessages,
  withToolCallIds,
  withUsageOnAssistant,
} from "./mapping.entity.functions.js"
export type { ToolResultSummary } from "./mapping.entity.functions.js"
export { foldStreamParts } from "./stream-fold.entity.functions.js"
export type { FoldedTurn, StreamDelta } from "./stream-fold.entity.functions.js"
export { strictJsonSchema, toolParametersSchema } from "./tool-schema.entity.functions.js"
