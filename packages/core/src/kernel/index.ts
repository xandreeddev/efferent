// `@xandreed/core/kernel`: what every part of the kernel agrees on. Its
// value objects and entities, the event definitions and the helpers a
// plugin defines its own with, the pure rules, the four contracts and their
// kits, and `Core`: publish, on, events, built with `Settings` by `kernel`.
// It imports nothing of the rest of core, no model type and no runtime module.
export { EventName, Owner, PluginName, Seq, SessionId, StepNumber, Tokens, ToolCallId, TurnNumber } from "./ids.entity.js"
export { firstStep } from "./ids.entity.functions.js"
export { AssistantMessage, Message, Reply, ToolCall, UserMessage } from "./message.entity.js"
export { replyOf, wantsTools } from "./message.entity.functions.js"
export { AnnouncedEvent, KernelEvent, ListenerFailed, LiveEvent, SeqRange, StoredDraft, StoredEvent } from "./event.entity.js"
export type { Delivered, EventDefinition, LiveDefinition, PluginFailure, StoredDefinition } from "./event.entity.js"
export { announced, dataOf, live, liveEvent, originOf, stored, storedEvent } from "./event.entity.functions.js"
export {
  AssistantDeltaData,
  AssistantMessageData,
  KERNEL_READER,
  ListenerFailedData,
  TurnEndedData,
  TurnOutcome,
  TurnStartedData,
  assistantDeltaEvent,
  assistantMessageEvent,
  listenerFailedEvent,
  requestSentEvent,
  turnEndedEvent,
  turnStartedEvent,
  userMessageEvent,
} from "./vocabulary.entity.js"
export {
  assistantDelta,
  assistantMessage,
  listenerFailed,
  outcomeOf,
  requestSent,
  turnEnded,
  turnStarted,
  userMessage,
} from "./vocabulary.entity.functions.js"
export { Journal, Reader, JournalStorageError, UnknownRecord } from "./journal.entity.js"
export { messageOf, readJournal, readerFor } from "./journal.entity.functions.js"
export { Free, InvalidSession, JOURNAL_FORMAT, NewSession, SessionHeader, SessionRefused, SessionState, TurnInput, TurnOpen } from "./session.entity.js"
export type { NewSessionInput } from "./session.entity.js"
export { beginTurn, endTurn, headerOf, newSession, sessionStateOf } from "./session.entity.functions.js"
export { Inspection, ModelRequest, PointedMessage, RequestRefused, ResolvedRequest, SentRequest } from "./request.entity.js"
export { estimateRequest, estimateTokens, inspectionOf, resolveRequest } from "./request.entity.functions.js"
export { Core } from "./core.port.js"
export type { ListenOptions, PublishOptions } from "./core.port.js"
export { kernel, makeCore } from "./core.adapter.js"
export type { KernelOptions } from "./core.adapter.js"
export { JournalStorage } from "./journal-storage.port.js"
export { Sessions } from "./sessions.port.js"
export type { OpenSession, TurnFailure } from "./sessions.port.js"
export { Memory } from "./memory.port.js"
export type { MemoryFailure } from "./memory.port.js"
export { Loop } from "./loop.port.js"
export type { LoopFailure } from "./loop.port.js"
export { Settings } from "./settings.port.js"
export { ConformanceFailure } from "./conformance.entity.js"
export type { ConformanceCheck } from "./conformance.entity.js"
export { journalStorageConformance } from "./journal-storage.conformance.js"
export type { JournalStorageSubject } from "./journal-storage.conformance.js"
export { sessionsConformance } from "./sessions.conformance.js"
export type { SessionsSubject } from "./sessions.conformance.js"
export { memoryConformance } from "./memory.conformance.js"
export type { MemorySubject } from "./memory.conformance.js"
export { LoopScript, ModelAnswer } from "./loop.entity.js"
export { loopConformance } from "./loop.conformance.js"
export type { LoopSubject } from "./loop.conformance.js"
