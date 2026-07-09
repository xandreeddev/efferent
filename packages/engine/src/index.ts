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
} from "./domain/Message.js"
export { Failure, toFailure } from "./domain/Failure.js"
export { addUsage, TokenUsage, zeroUsage } from "./domain/TokenUsage.js"
export {
  formatModelSelection,
  ModelId,
  ModelSelection,
  parseModelSelection,
  ProviderId,
} from "./domain/ModelSelection.js"
export type { LoopEvent, ToolCallSummary } from "./domain/LoopEvent.js"

// ports
export {
  ConversationStore,
  ConversationSummary,
  StoreError,
} from "./ports/ConversationStore.js"
export { EngineSettings, SettingsError, SettingsStore } from "./ports/SettingsStore.js"
export type { ModelRole } from "./ports/SettingsStore.js"
export { AuthError, AuthStore, Credential } from "./ports/AuthStore.js"
export { FileSystem, FsError } from "./ports/FileSystem.js"
export { Shell, ShellError, ShellResult } from "./ports/Shell.js"
export { UtilityCompletion, UtilityError, UtilityLlm } from "./ports/UtilityLlm.js"

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
export { runAgent } from "./loop/runAgent.js"
export type { AgentConfig, CompactionPolicy } from "./loop/runAgent.js"

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
