// `@xandreed/core/conformance`: every port's kit, run against each adapter of
// the port under any test runner, and what a kit is made of. The
// `ToolRegistry` kit runs its turns over the sdk's `TurnLive`, so it is
// `@xandreed/sdk/conformance`.
export { ConformanceFailure } from "../conformance.entity.js"
export type { ConformanceCheck } from "../conformance.entity.js"
export { check } from "../conformance.functions.js"
// the FileSystem and Bash contracts
export { fileSystemConformance } from "../workspace/file-system.conformance.js"
export type { FileSystemFixture, FileSystemSubject } from "../workspace/file-system.conformance.js"
export { bashConformance } from "../workspace/bash.conformance.js"
export type { BashFixture, BashSubject } from "../workspace/bash.conformance.js"
// the session log, Sessions, TaskRunner and Tasks
export { sessionLogConformance } from "../session/session-log.conformance.js"
export { sessionLogRecoveryConformance } from "../session/session-log.recovery.conformance.js"
export type { SessionLogSubject } from "../session/session-log.recovery.conformance.js"
export { sessionsConformance } from "../session/sessions.conformance.js"
export type { SessionsInstance, SessionsProcess, SessionsSubject } from "../session/sessions.conformance.js"
export { inboxRunnerConformance } from "../session/inbox-runner.conformance.js"
export type { InboxRunnerSubject } from "../session/inbox-runner.conformance.js"
export { taskRunnerConformance, tasksConformance } from "../session/tasks.conformance.js"
export type { TaskRunnerFixture, TasksDependencies, TasksFixture } from "../session/tasks.conformance.js"
// the turn: its step loop, memory, the turn itself and the tool registry
export { probeCall, stepLoopConformance, textReply } from "../turn/step-loop.conformance.js"
export { inMemoryLog, memoryConformance } from "../memory/memory.conformance.js"
export { turnConformance } from "../turn/turn.conformance.js"
// the model catalog
export { modelCatalogConformance } from "../domain/model-catalog.conformance.js"

export { imageResizerConformance, imageResizerPng } from "../workspace/image-resizer.conformance.js"
export type { ImageResizerSubject } from "../workspace/image-resizer.conformance.js"
