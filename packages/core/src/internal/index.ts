// `@xandreed/core/internal`: what the agent loop, the models plugin and the
// sdk share with core, with no semver: the provider mapping, the stream fold,
// tool schemas and the model a response names. Imported by first-party
// packages only, each export by one at least.
export {
  extractUsage,
  handoffToMessage,
  responseReasoning,
  responseText,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
  toPromptMessages,
  withToolCallIds,
  withUsageOnAssistant,
} from "./mapping.entity.functions.js"
export { foldStreamParts } from "./stream-fold.entity.functions.js"
export { strictJsonSchema, toolParametersSchema } from "./tool-schema.entity.functions.js"
