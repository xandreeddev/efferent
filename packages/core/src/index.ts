// domain
export {
  AgentMessage,
  AgentResult,
  AssistantMessage,
  ConversationId,
  ProviderOptions,
  ReasoningPart,
  TextPart,
  ToolCallId,
  ToolCallPart,
  ToolMessage,
  ToolResultPart,
  UserContentPart,
  UserRoleMessage,
} from "./domain/message.entity.js"
export { ENGINE_KEY, ResponseStamp } from "./domain/engine-stamp.entity.js"
export { responseModelOf, stampPartModel, stampResponseModel } from "./domain/engine-stamp.entity.functions.js"
export {
  AttachmentRejected,
  AttachmentRejectedReason,
  ImageMediaType,
  Media,
  MEDIA_LIMITS,
  MediaFingerprint,
  MediaSlot,
} from "./domain/media.entity.js"
export {
  elideMediaData,
  IMAGE_TOKEN_ESTIMATE,
  isMediaValue,
  mediaFromBase64,
  mediaFromBytes,
  mediaLabel,
  mediaSlotsOf,
  sniffImageType,
  toolResultMedia,
} from "./domain/media.entity.functions.js"
export type { MediaDescription, ToolResultMedia } from "./domain/media.entity.functions.js"
export { Failure } from "./domain/failure.entity.js"
export { errorCodeOf, reasonOf } from "./domain/failure.entity.functions.js"
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
export { StepStatus, TurnEndReason, TurnEnding, TurnFailure, TurnOrigin, TurnOutcomeKind } from "./domain/turn-vocabulary.entity.js"
export { InvocationId, RunId, RunKey, RunOrdinal, RunRef } from "./domain/run.entity.js"
export { plannedCallIdOf, toolCallIdOf } from "./domain/run.entity.functions.js"
export { DirEntry, FileInfo, FileKind, FsError, FsReason, GlobOptions, GlobResult, ReadRange, RecursiveOptions, StatOptions, WriteOptions } from "./domain/file-system.entity.js"
export { walkGlob } from "./domain/file-system.entity.functions.js"
export { BASH_ENV_ALLOWLIST, BashChunk, BashError, BashErrorReason, BashEvent, BashExit, BashOptions, BashResult, BashTermination } from "./domain/bash.entity.js"
export { collectBashResult, resolveBashEnv } from "./domain/bash.entity.functions.js"

// ports
export { ModelCatalog } from "./ports/model-catalog.port.js"
export { FileSystem } from "./ports/file-system.port.js"
export { Bash } from "./ports/bash.port.js"
export { UtilityCompletion, UtilityError, UtilityLlm } from "./ports/utility-llm.port.js"

// workspace: the in-memory FileSystem backend
export { FileSystemMemoryLive, makeMemoryFileSystem } from "./workspace/file-system.memory.adapter.js"
export type { MemoryFileSystem, MemorySeed } from "./workspace/file-system.memory.adapter.js"

// loop
export { CurrentPromptCacheKey } from "./loop/cacheKey.js"
export { CurrentTraceContent, replayableContext } from "./loop/traceContent.js"

// the session log: the storage a host provides, its in-memory backend and its contract
export {
  JsonObject,
  LeaseExpired,
  RevisionConflict,
  SessionCommit,
  SessionCommitted,
  SessionDraft,
  SessionExists,
  SessionHead,
  SessionHeader,
  SessionLineage,
  SessionListCursor,
  SessionListQuery,
  SessionLogError,
  SessionLogEvent,
  SessionMissing,
  SessionReadQuery,
} from "./session/session-log.entity.js"
export { isRevisionConflict, isStoreBusy, storedJson } from "./session/session-log.entity.functions.js"
export { SessionLog } from "./ports/session-log.port.js"
export { SessionLogMemoryLive } from "./session/session-log.memory.adapter.js"
export {
  InboxDroppedData,
  InboxQueuedData,
  MEMORY_KINDS,
  MemoryKindOf,
  RECORDED_ELSEWHERE,
  RESERVED_KINDS,
  SESSION_KINDS,
  StepUsageData,
  TURN_EVENT_KINDS,
  TurnEndedData,
  TurnStartedData,
} from "./session/session-event.entity.js"
export { JOURNAL_KINDS } from "./session/session-event.entity.js"
export {
  entriesOfEvents,
  frameworkDraft,
  journalSchemaOf,
  replyEndingOf,
  StoredMemoryData,
  turnEndedDraft,
  turnEndedOf,
  turnStartedDraft,
  turnStartedOf,
  unmarkedReservedDraft,
} from "./session/session-event.entity.functions.js"
export { turnUsageOf } from "./session/session-event.entity.functions.js"
// stored records read by their fields: decoded whole, or by their keys alone for a lookup
export { readStored, readStoredKeys, RequestPreparedKeys, StoredData, StoredKeys, TurnStartedKeys } from "./session/session-event.entity.functions.js"
export type { KeyedKind, Stored, StoredKeysOf, StoredKind } from "./session/session-event.entity.functions.js"
export {
  AdmittedTurn,
  BeginTurn,
  InboxFull,
  InboxItem,
  InboxItemId,
  KeyConflict,
  NothingPending,
  NotResumable,
  OpenTurn,
  ReservedKind,
  RunIdReused,
  SessionAddress,
  SessionBusy,
  SessionContended,
  SessionPage,
  SessionView,
  turnBeginCodes,
  TurnBeginError,
  TurnClosed,
  TurnDuplicate,
  TurnRefused,
} from "./session/sessions.entity.js"
export type { TurnError } from "./session/sessions.entity.js"
export { isTurnError, resumeRefusal, sessionAttributes, turnAttributes, turnEndingOf } from "./session/sessions.entity.functions.js"
export type { ResumableTurn } from "./session/sessions.entity.functions.js"
export { Sessions } from "./ports/sessions.port.js"
export type { Decided, Decision, TurnDraft, TurnWriter } from "./ports/sessions.port.js"
export { TurnAdmission } from "./ports/turn-admission.port.js"
export type { TurnToAdmit } from "./ports/turn-admission.port.js"
export { TurnAdmissionOpen } from "./session/turn-admission.open.adapter.js"
export {
  TaskConflict,
  TaskMissing,
  TaskMode,
  TaskRef,
  TaskRefused,
  TaskStatus,
  TaskView,
} from "./session/tasks.entity.js"
export { TaskExecutor, TaskRunner, Tasks } from "./ports/tasks.port.js"
// what this process is busy with: open turns and running background work, for a `/ping` or a drain
export { ActiveTurn, ProcessActivity, TurnsInFlight } from "./session/activity.entity.js"
export { awaitIdle, processActivity } from "./session/activity.entity.functions.js"
export { TaskActivity, TurnActivity } from "./ports/activity.port.js"

export { HarnessError, PLUGIN_API_VERSION, SUPPORTED_PLUGIN_API_VERSIONS } from "./harness/plugin.entity.js"
export type { PartialOptions, Plugin, TypedPlugin } from "./harness/plugin.entity.js"
export { isHarnessError, mergeOptions, provideDeclared } from "./harness/plugin.entity.functions.js"
export type { ServiceKeys } from "./harness/plugin.entity.functions.js"
export { HARNESS_CODES, HarnessCode, TAGGED_CODES } from "./harness/harness-code.entity.js"
export { harnessCodeOf, harnessError } from "./harness/harness-code.entity.functions.js"
export { definePlugin } from "./harness/plugin.adapter.js"
export { CapabilitiesLive, stackPlugins } from "./harness/plugin-stack.adapter.js"
export { HarnessConfig, PluginEntry, PluginInstanceId } from "./harness/config.entity.js"
export { ActionPolicy, SessionEnvironment } from "./ports/harness.port.js"

export { PromptId, PromptProvenance } from "./domain/prompt-provenance.entity.js"

export { CurrentPromptProvenance } from "./loop/promptProvenance.js"

export { CurrentAgentStep, CurrentToolInvocation } from "./loop/stepContext.js"
export type { ToolInvocation } from "./loop/stepContext.js"

export { CandidateId, DecisionId, DecisionRecord } from "./decision-record.entity.js"

// memory: the append-only log, its ports and the pure rebuild
export {
  ActivationSource,
  ArtifactId,
  ArtifactRef,
  BuiltContext,
  CompactionAction,
  EntryId,
  LogBody,
  LogEntry,
  SectionId,
  Subject,
  SubjectId,
  TurnContextBody,
} from "./memory/memory-log.entity.js"
export type { LogQuery } from "./memory/memory-log.entity.js"
export {
  activationsOf,
  canonicalJson,
  digestTranscript,
  emptyQuery,
  entryId,
  estimateMessageTokens,
  fingerprintOf,
  ledgerOf,
  pendingCompaction,
  queryLog,
  renderLog,
  rewrittenBy,
  toolInputsOf,
} from "./memory/memory-log.entity.functions.js"
export type { RenderOptions } from "./memory/memory-log.entity.functions.js"
export { noMaintenance, openLogSession } from "./memory/memory-session.js"
export type { MaintainDecision, MemoryPolicy } from "./memory/memory-session.js"
export { ConversationMemory, ResultDigester } from "./ports/memory.port.js"
export type {
  DigestOutcome,
  DigestTask,
  LogHandle,
  MaintainSignal,
  MemoryReader,
  MemorySession,
  ToolView,
  ToolViews,
} from "./ports/memory.port.js"

// capabilities: host-defined tools, skills and prompt sections, and the permissions a run holds
export {
  CapabilityCatalog,
  CapabilityId,
  CapabilityRecipe,
  CapabilitySelection,
  CapabilityTool,
  CapabilityToolId,
  PromptTier,
  ResolvedCapabilities,
  SkillDefinition,
  SkillId,
  SkillReference,
  SkillReferenceId,
  ToolAnnotations,
} from "./harness/capability.entity.js"
export {
  catalogOf,
  defineCapability,
  definePromptSection,
  defineSkill,
  defineTool,
  resolveCapabilities,
} from "./harness/capability.entity.functions.js"
export type { SkillInput } from "./harness/capability.entity.functions.js"
export { Capabilities, IntentMatcher } from "./ports/capability.port.js"
export type {
  Capability,
  DigestDefinition,
  InitialBatch,
  IntentMatch,
  ModelChoice,
  PromptContext,
  PromptSection,
  RegisteredTool,
  StepDirective,
  StepInfo,
  ToolChoice,
  ToolDefinition,
  ToolViewDefinition,
  ToolViewInput,
} from "./ports/capability.port.js"
export { PermissionGrants } from "./ports/permission.port.js"
export { RunContext } from "./ports/run-context.port.js"
export { ToolRegistry } from "./ports/tool-registry.port.js"
export type { RunTools, SkillMatch, ToolHandlers } from "./ports/tool-registry.port.js"

// the host-composed turn: the user's message, typed events, background tasks, the step loop and the turn
export { UserMessage } from "./turn/user-message.entity.js"
export { attachmentsOf, normalizeUserMessage, sameUserMessage, userMessageText } from "./turn/user-message.entity.functions.js"
export {
  AssistantDeltaEvent,
  AssistantMessageEvent,
  CompletionEvaluatedEvent,
  CompletionVerdict,
  ContextBuiltEvent,
  DecisionRecordedEvent,
  HostEvent,
  SkillsActivatedEvent,
  StepEndedEvent,
  StepResult,
  StepStartedEvent,
  StreamPartId,
  ToolCompletedEvent,
  ToolProgressEvent,
  ToolStartedEvent,
  TransientTurnEvents,
  TurnEndedEvent,
  TurnEvent,
  TurnStartedEvent,
} from "./turn/turn-event.entity.js"
export type { TurnEventName, TurnEventOf } from "./turn/turn-event.entity.js"
export { StreamFallbackEvent, ToolRefusalReason, ToolRefusedEvent, TURN_EVENT_NAMES } from "./turn/turn-event.entity.js"
export {
  defineHostEvent,
  onEvent,
  onTool,
  publishToolProgress,
  subscribeAll,
} from "./turn/turn-event.entity.functions.js"
export type { ToolCall } from "./turn/turn-event.entity.functions.js"
export {
  MemoryRenderRecipe,
  ModelRequestDescriptor,
  ModelRequestHeader,
  ModelRequestTool,
  ProviderToolId,
} from "./turn/model-request.entity.js"
export {
  describeModel,
  freezeModelRequest,
  modelRequestDescriptorOf,
  replayModelRequest,
  resolveModelRequest,
  resolvingModel,
} from "./turn/model-request.entity.functions.js"

export { TurnEvents, TurnTasks } from "./ports/turn-events.port.js"
export type { SubscribeOptions, Subscription, TurnEventsService, TurnTasksService } from "./ports/turn-events.port.js"
export { StepLoop, StepLoopReferences } from "./ports/step-loop.port.js"
export type {
  Correctives,
  LoopLimits,
  ModelDispatch,
  RunResult,
  StepPlan,
  StepRequest,
} from "./ports/step-loop.port.js"
export type {
  NewTurn,
  Turn,
  TurnInput,
  TurnOutcome,
  TurnPolicy,
  TurnRunner,
  TurnServices,
  TurnTools,
} from "./ports/turn.port.js"
export type { TurnResult } from "./ports/turn.port.js"
export { TurnMemory, TurnPrompt, TurnToolbox } from "./ports/turn-scope.port.js"
export type { RequestSnapshot, TurnContextEntry, TurnLiveInput, TurnRunOptions } from "./ports/turn-scope.port.js"

export { clippedMarker, clipTo, escapeFrame, framed, hostNote } from "./turn/model-text.js"
export { recordDecision } from "./decision-record.entity.functions.js"
export { CollectSkillFilesOptions, SkillFile, SkillFileIssue, SkillFilesOptions, SkillTree, SkillTreeEntry } from "./harness/skill-files.entity.js"
export { collectSkillFiles, readSkillFiles, skillIssuesText, skillsFromFiles } from "./harness/skill-files.entity.functions.js"

// Declared in `internal/` or `engine/` and still a root name, as the same
// value or a type of the same shape: a root entry may not re-export what
// those folders declare (`scripts/api-snapshot.ts`).
import * as glob from "./internal/glob.entity.functions.js"
import * as mapping from "./internal/mapping.entity.functions.js"
import * as turnBus from "./engine/turn-bus.adapter.js"

export const compileGlob: typeof glob.compileGlob = glob.compileGlob
/** @public */
export interface GlobMatcher extends glob.GlobMatcher {}
/** @public */
export interface GlobMatchOptions extends glob.GlobMatchOptions {}
/** @public */
export const assistantModel: typeof mapping.assistantModel = mapping.assistantModel
/** @public */
export const assistantUsage: typeof mapping.assistantUsage = mapping.assistantUsage
export const harnessDefectsAsFailures: typeof turnBus.harnessDefectsAsFailures = turnBus.harnessDefectsAsFailures
