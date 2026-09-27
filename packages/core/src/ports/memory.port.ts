import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { AgentMessage, ConversationId } from "../domain/message.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { EventBody, SessionEvent } from "../harness/session.entity.js"
import type { LogQuery } from "../memory/memory-log.entity.functions.js"
import type { BuiltContext, EntryId, LogBody, LogEntry, Subject } from "../memory/memory-log.entity.js"

/**
 * Host-authorized journal access for one run. The Harness backs it with its
 * SessionStore; an application host backs it with its own fenced journal.
 */
export interface RunIO {
  readonly publish: (event: EventBody) => Effect.Effect<SessionEvent, HarnessError>
  readonly history: (after: number, names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<SessionEvent>, HarnessError>
}

/** STORAGE: where log entries live. Strategies never know the store. */
export class MemoryLog extends Context.Tag("efferent/MemoryLog")<MemoryLog, {
  readonly open: (conversation: ConversationId, io: RunIO) => Effect.Effect<{
    readonly read: Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
    /** One atomic append; entry ids derive from the journal position. */
    readonly append: (runId: string, at: { readonly turn: number; readonly step: number }, bodies: ReadonlyArray<LogBody>) =>
      Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  }, HarnessError>
}>() {}

/** One tool result as the model sees it, supplied by whoever owns the tools. */
export interface ToolView {
  readonly text: string
  readonly version: string
  readonly subjects: ReadonlyArray<Subject>
  readonly pinned: boolean
}

/** Tool views by name — the memory strategy applies them without knowing any tool. */
export interface ToolViews {
  readonly view: (tool: string, encoded: unknown, params: unknown, isError: boolean) => Effect.Effect<ToolView>
  /** The older-turn form; None keeps the write-time view. */
  readonly compact: (tool: string, encoded: unknown, params: unknown) => Effect.Effect<Option.Option<string>>
}

/** Read-only memory for tools, hooks and matchers. */
export interface MemoryReader {
  readonly turn: Effect.Effect<number>
  readonly entries: Effect.Effect<ReadonlyArray<LogEntry>>
  readonly query: (query: LogQuery) => Effect.Effect<ReadonlyArray<LogEntry>>
  readonly subjects: (kinds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Subject>>
  readonly resolve: (id: EntryId) => Effect.Effect<Option.Option<LogEntry>>
  readonly transcript: (fidelity: "raw" | "model" | "reference") => Effect.Effect<ReadonlyArray<AgentMessage>>
}

export interface MaintainSignal {
  readonly phase: "turn-start" | "step"
  readonly lastUsage: Option.Option<TokenUsage>
  /** Tokens available to the messages (system and tool schemas already deducted). */
  readonly budgetTokens: number
  readonly views: ToolViews
}

export interface MemorySession extends MemoryReader {
  readonly strategy: { readonly id: string; readonly version: string }
  readonly record: (bodies: ReadonlyArray<LogBody>, step: number) => Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  /** The loop's appended messages → Message and ToolResult entries (views applied at write time). */
  readonly recordTail: (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number) => Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  /** The only place compaction is decided; the decision is recorded before it applies. */
  readonly maintain: (signal: MaintainSignal) => Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  /** A pure fold of the log: what the next request sends. */
  readonly build: Effect.Effect<BuiltContext, HarnessError>
}

/** STRATEGY: how memory is kept, compacted and rebuilt. Swap this plugin to swap memory. */
export class ConversationMemory extends Context.Tag("efferent/ConversationMemory")<ConversationMemory, {
  readonly strategy: { readonly id: string; readonly version: string }
  readonly open: (scope: { readonly conversation: ConversationId; readonly runId: string; readonly io: RunIO }) =>
    Effect.Effect<MemorySession, HarnessError, Scope.Scope>
}>() {}
