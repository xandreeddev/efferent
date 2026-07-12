// domain
export {
  AgentMessage,
  AgentResult,
  AssistantMessage,
  Checkpoint,
  ConversationId,
  ReasoningPart,
  TextPart,
  ToolCallId,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  UserMessage,
} from "./domain/message.entity.js"
export { Failure } from "./domain/failure.entity.js"
export { toFailure } from "./domain/failure.entity.functions.js"
export { AgentFailure, AgentFailureCategory } from "./domain/agent-failure.entity.js"
export type { AgentFailure as AgentFailureType, AgentFailureCategory as AgentFailureCategoryType } from "./domain/agent-failure.entity.js"
export { toAgentFailure, toolResultFailure } from "./domain/agent-failure.entity.functions.js"
export { TokenUsage } from "./domain/token-usage.entity.js"
export { addUsage, zeroUsage } from "./domain/token-usage.entity.functions.js"
export {
  ModelId,
  ModelSelection,
  ProviderId,
} from "./domain/model-selection.entity.js"
export { ModelCallPolicy, ReasoningEffort } from "./domain/model-call-policy.entity.js"
export type { ReasoningEffort as ReasoningEffortType } from "./domain/model-call-policy.entity.js"
export { ModelCatalogEntry } from "./domain/model-catalog.entity.js"
export type { ModelCatalogEntry as ModelCatalogEntryType } from "./domain/model-catalog.entity.js"
export type { ModelCallPolicy as ModelCallPolicyType } from "./domain/model-call-policy.entity.js"
export { CurrentModelCallPolicy } from "./loop/modelPolicy.js"
export { formatModelSelection, parseModelSelection } from "./domain/model-selection.entity.functions.js"
export type { LoopEvent, ToolCallSummary } from "./domain/loop-event.entity.js"

// ports
export {
  ConversationStore,
  ConversationSummary,
  StoreError,
} from "./ports/conversation-store.port.js"
export {
  EngineSettings,
  SETTINGS_KEYS,
  SettingsError,
  SettingsStore,
} from "./ports/settings-store.port.js"
export type { ModelRole, SettingsKey } from "./ports/settings-store.port.js"
export { AuthError, AuthStore, Credential } from "./ports/auth-store.port.js"
export { ModelCatalog } from "./ports/model-catalog.port.js"
export { FileSystem, FsError } from "./ports/file-system.port.js"
export { Shell, ShellError, ShellResult } from "./ports/shell.port.js"
export { UtilityCompletion, UtilityError, UtilityLlm } from "./ports/utility-llm.port.js"

// util
export { asJsonRecord, decodeJsonLines, parseJsonOption, parseJsonWarn } from "./util/json.js"

// loop
export {
  assistantModel,
  assistantUsage,
  extractUsage,
  handoffToMessage,
  safeKeepFrom,
  responseReasoning,
  responseText,
  responseToAgentMessages,
  responseToolCalls,
  responseToolResults,
  toPromptMessages,
  withToolCallIds,
  withUsageOnAssistant,
} from "./loop/mapping.js"
export type { ToolResultSummary } from "./loop/mapping.js"
export {
  DEFAULT_MAX_STEPS,
  DEFAULT_TOOL_CONCURRENCY,
  DEGENERATE_LOOP_STOP,
  DEGENERATE_REPEAT_NUDGE,
  runLoop,
} from "./loop/loop.js"
export type { CompactionPlan, RunLoopOptions } from "./loop/loop.js"
export { CurrentPromptCacheKey } from "./loop/cacheKey.js"
export { foldStreamParts } from "./loop/streamFold.js"
export type { FoldedTurn, StreamDelta } from "./loop/streamFold.js"
export { runAgent } from "./loop/runAgent.js"
export type { AgentConfig, CompactionPolicy } from "./loop/runAgent.js"
export { McpCallOutcome, McpClient, McpError, McpToolDescriptor } from "./ports/mcp-client.port.js"
export { buildMcpBridge, emptyMcpBridge, McpCall, McpDescribe } from "./mcp/bridge.js"
export type { McpBridge, McpBridgedTool } from "./mcp/bridge.js"

// session
export { makeSession } from "./session/chassis.js"
export type { SeqEvent, Session } from "./session/chassis.js"

// spec (the spec-driven pipeline's shared vocabulary — re-homed from the old line)
export {
  DEFAULT_SPEC_LIMITS,
  renderSpecSection,
  SpecCheck,
  SpecDoc,
  SpecGates,
  SpecLimits,
  SpecSlug,
  SpecStatus,
} from "./spec/SpecDoc.js"
export {
  decodeSpecDocText,
  encodeSpecDocText,
  SpecDocParseError,
  specSlug,
  uniqueSlug,
} from "./spec/codec.js"
export { parseFrontmatter } from "./spec/frontmatter.js"
