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
  UserRoleMessage,
} from "./domain/message.entity.js"
export { Failure } from "./domain/failure.entity.js"
export { toFailure } from "./domain/failure.entity.functions.js"
export { AgentFailure, AgentFailureCategory } from "./domain/agent-failure.entity.js"
export type { AgentFailure as AgentFailureType, AgentFailureCategory as AgentFailureCategoryType } from "./domain/agent-failure.entity.js"
export { toAgentFailure, toolResultFailure } from "./domain/agent-failure.entity.functions.js"
export { BudgetTokens, ModelPrice, TokenUsage, UsageBreakdown } from "./domain/token-usage.entity.js"
export {
  addUsage,
  costOf,
  isBudgetTokens,
  sumUsage,
  tokenUsage,
  uncachedInputTokens,
  usageBreakdown,
  zeroUsage,
} from "./domain/token-usage.entity.functions.js"
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
export { CurrentEmptyResponseTolerance, CurrentModelCallPolicy } from "./loop/modelPolicy.js"
export { formatModelSelection, parseModelSelection } from "./domain/model-selection.entity.functions.js"
export type { LoopEvent, ToolCallSummary } from "./domain/loop-event.entity.js"
export { DirEntry, FileInfo, FileKind, FsError, FsReason, GlobOptions, GlobResult, ReadRange, RecursiveOptions, StatOptions, WriteOptions } from "./domain/file-system.entity.js"
export { walkGlob } from "./domain/file-system.entity.functions.js"
export { BASH_ENV_ALLOWLIST, BashChunk, BashError, BashErrorReason, BashEvent, BashExit, BashOptions, BashResult, BashTermination } from "./domain/bash.entity.js"
export { collectBashResult, resolveBashEnv } from "./domain/bash.entity.functions.js"

// ports
export {
  EngineSettings,
  SETTINGS_KEYS,
  SettingsError,
  SettingsStore,
} from "./ports/settings-store.port.js"
export type { ModelRole, SettingsKey } from "./ports/settings-store.port.js"
export { AuthError, AuthStore, Credential } from "./ports/auth-store.port.js"
export { ModelCatalog } from "./ports/model-catalog.port.js"
export { FileSystem } from "./ports/file-system.port.js"
export { Bash } from "./ports/bash.port.js"
export { UtilityCompletion, UtilityError, UtilityLlm } from "./ports/utility-llm.port.js"

// util
export { asJsonRecord, decodeJsonLines, parseJsonOption, parseJsonWarn } from "./util/json.js"
export { compileGlob, globMatcher } from "./util/glob.js"
export type { GlobMatcher, GlobMatchOptions } from "./util/glob.js"

// workspace: the in-memory FileSystem backend and the FileSystem and Bash contracts
export { FileSystemMemoryLive, makeMemoryFileSystem } from "./workspace/file-system.memory.adapter.js"
export type { MemoryFileSystem, MemorySeed } from "./workspace/file-system.memory.adapter.js"
export { fileSystemConformance } from "./workspace/file-system.conformance.js"
export type { FileSystemFixture, FileSystemSubject } from "./workspace/file-system.conformance.js"
export { bashConformance } from "./workspace/bash.conformance.js"
export type { BashFixture, BashSubject } from "./workspace/bash.conformance.js"

// loop
export {
  assistantModel,
  assistantUsage,
  extractUsage,
  extractModel,
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
export { CurrentPromptCacheKey } from "./loop/cacheKey.js"
export { foldStreamParts } from "./loop/streamFold.js"
export { strictJsonSchema, toolParametersSchema } from "./loop/toolSchema.js"
export type { FoldedTurn, StreamDelta } from "./loop/streamFold.js"
export { McpCallOutcome, McpClient, McpError, McpToolDescriptor } from "./ports/mcp-client.port.js"
export { buildMcpBridge, emptyMcpBridge, McpCall, McpDescribe } from "./mcp/bridge.js"
export type { McpBridge, McpBridgedTool } from "./mcp/bridge.js"

// session
export { makeSession } from "./session/chassis.js"
export type { SeqEvent, Session } from "./session/chassis.js"

// the session log: the storage a host provides, its in-memory backend and its contract
export * from "./session/session-log.entity.js"
export * from "./ports/session-log.port.js"
export { SessionLogMemoryLive } from "./session/session-log.memory.adapter.js"
export { sessionLogConformance } from "./session/session-log.conformance.js"
export { sessionLogRecoveryConformance } from "./session/session-log.recovery.conformance.js"
export type { SessionLogSubject } from "./session/session-log.recovery.conformance.js"
export * from "./session/session-event.entity.js"
export * from "./session/session-event.entity.functions.js"
export { turnUsageOf } from "./session/session-event.entity.functions.js"
export * from "./session/sessions.entity.js"
export { turnEndingOf } from "./session/sessions.entity.functions.js"
export * from "./ports/sessions.port.js"
export * from "./ports/turn-admission.port.js"
export { TurnAdmissionOpen } from "./session/turn-admission.open.adapter.js"
export * from "./session/tasks.entity.js"
export * from "./ports/tasks.port.js"

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
export * from "./harness/plugin.entity.js"
export * from "./harness/plugin.adapter.js"
export * from "./harness/plugin-stack.adapter.js"
export * from "./harness/config.entity.js"
export * from "./ports/harness.port.js"

export { defineAgent, defineConfig } from "./harness/config.entity.functions.js"

export * from "./domain/prompt-provenance.entity.js"

export * from "./loop/promptProvenance.js"

export { CurrentAgentStep, CurrentToolInvocation } from "./loop/stepContext.js"
export type { ToolInvocation } from "./loop/stepContext.js"

export * from "./decision-record.entity.js"

// memory: the append-only log, its ports and the pure rebuild
export * from "./memory/memory-log.entity.js"
export * from "./memory/memory-log.entity.functions.js"
export * from "./memory/memory-session.js"
export * from "./ports/memory.port.js"

// capabilities: host-defined tools, skills and prompt sections, and the permissions a run holds
export * from "./harness/capability.entity.js"
export * from "./harness/capability.entity.functions.js"
export * from "./ports/capability.port.js"
export * from "./ports/permission.port.js"
export * from "./ports/run-context.port.js"
export * from "./ports/tool-registry.port.js"

// the host-composed turn: the user's message, typed events, background tasks, the step loop and the turn
export * from "./turn/user-message.entity.js"
export * from "./turn/turn-event.entity.js"
export * from "./turn/turn-event.entity.functions.js"
export * from "./turn/model-request.entity.js"
export * from "./turn/model-request.entity.functions.js"
export * from "./turn/turn-bus.js"
export * from "./ports/turn-events.port.js"
export * from "./ports/step-loop.port.js"
export * from "./ports/turn.port.js"
export type { TurnResult } from "./ports/turn.port.js"
export * from "./ports/turn-scope.port.js"
export * from "./turn/prompt-sections.js"
export * from "./turn/turn.adapter.js"
export * from "./turn/turn-run.js"
export * from "./turn/turn-lifecycle.js"
export * from "./decision-record.entity.functions.js"
export { skillsFromFiles } from "./harness/skill-files.js"
export type { SkillFile } from "./harness/skill-files.js"
export { ConformanceFailure } from "./conformance.entity.js"
export type { ConformanceCheck } from "./conformance.entity.js"
export { probeCall, stepLoopConformance, textReply } from "./turn/step-loop.conformance.js"
export { inMemoryLog, memoryConformance } from "./memory/memory.conformance.js"
export { turnConformance } from "./turn/turn.conformance.js"
export { authStoreConformance } from "./models/auth-store.conformance.js"
export { settingsStoreConformance } from "./models/settings-store.conformance.js"
export { modelCatalogConformance } from "./models/model-catalog.conformance.js"
