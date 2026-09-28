import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { AgentMessage, ConversationId } from "../domain/message.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { EventBody } from "../harness/session.entity.js"
import type { LogQuery } from "../memory/memory-log.entity.functions.js"
import type { ArtifactRef, BuiltContext, EntryId, LogBody, LogEntry, Subject } from "../memory/memory-log.entity.js"

/**
 * Host-authorized journal access for one conversation: append an event,
 * read the conversation's events back by name, in append order. The host
 * backs it with its own fenced store.
 */
export interface JournalIO {
  readonly append: (event: EventBody) => Effect.Effect<void, HarnessError>
  /** Several events in order, in one write when the store can (one transaction, one round trip). */
  readonly appendAll?: (events: ReadonlyArray<EventBody>) => Effect.Effect<void, HarnessError>
  readonly read: (names: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<EventBody>, HarnessError>
}

/**
 * The turn's ordered write-behind journal (see `makeJournalWriter`). Appends
 * return once queued; one writer stores them in the order they were queued,
 * batching consecutive appends. A failed write is latched: the next append,
 * read, flush or write fails with it.
 */
export interface JournalWriter {
  /** The journal as memory and the event sink use it: `append` queues, `read` flushes first. */
  readonly io: JournalIO
  /** Wait until everything queued so far is stored. */
  readonly flush: Effect.Effect<void, HarnessError>
  /** Run `op` in journal order (after everything queued before it) and return its result. */
  readonly write: <A, E>(op: Effect.Effect<A, E>) => Effect.Effect<A, E | HarnessError>
}

/** An opened log: stored entries, and one atomic append. */
export interface LogHandle {
  readonly read: Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  readonly append: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<void, HarnessError>
}

/** STORAGE: where log entries live. Strategies never know the store. */
export class MemoryLog extends Context.Tag("efferent/MemoryLog")<MemoryLog, {
  readonly open: (conversation: ConversationId, io: JournalIO) => Effect.Effect<LogHandle, HarnessError>
}>() {}

/** One tool result as the model sees it, supplied by whoever owns the tools. */
export interface ToolView {
  readonly text: string
  readonly version: string
  readonly subjects: ReadonlyArray<Subject>
  readonly artifacts: ReadonlyArray<ArtifactRef>
  readonly pinned: boolean
}

/** What the digester returns: the item keys to keep, or a summary. */
export interface DigestOutcome {
  readonly keep: ReadonlyArray<string>
  readonly summary: Option.Option<string>
}

/** One result prepared for digestion by the tool that produced it. */
export interface DigestTask {
  readonly tool: string
  readonly version: string
  readonly mode: "select" | "summarize"
  /** The tool's own digest prompt. */
  readonly instructions: string
  /** The user request the digest must serve. */
  readonly question: string
  /** Select mode: the keyed items the digester chooses from. */
  readonly items: ReadonlyArray<{ readonly key: string; readonly text: string }>
  /** The full rendered result (summarize mode's input). */
  readonly source: string
  /** The text the model will see for this outcome; None keeps the original view. */
  readonly apply: (outcome: DigestOutcome) => Option.Option<string>
}

/** Tool views by name — the memory strategy applies them without knowing any tool. */
export interface ToolViews {
  readonly view: (tool: string, encoded: unknown, params: unknown, isError: boolean) => Effect.Effect<ToolView>
  /** The older-turn form; None keeps the write-time view. */
  readonly compact: (tool: string, encoded: unknown, params: unknown) => Effect.Effect<Option.Option<string>>
  /** The tool's digest of this result, when it declares one. */
  readonly digest: (tool: string, encoded: unknown, params: unknown, question: string) => Effect.Effect<Option.Option<DigestTask>>
}

/** Runs a tool's digest prompt (see `DigestDefinition`). Read from the turn's services. */
export class ResultDigester extends Context.Tag("efferent/ResultDigester")<ResultDigester, {
  readonly id: string
  readonly version: string
  readonly digest: (task: DigestTask) => Effect.Effect<DigestOutcome, HarnessError>
}>() {}

/** Read-only memory for tools, sections, matchers and reactions. */
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
  /** The loop's appended messages → Message and ToolResult entries (views, and digests the strategy asks for, at write time). */
  readonly recordTail: (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number) => Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  /** The only place compaction is decided; the decision is recorded before it applies. */
  readonly maintain: (signal: MaintainSignal) => Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  /** A pure fold of the log: what the next request sends. */
  readonly build: (request: { readonly stepContext: "tail" | "none" }) => Effect.Effect<BuiltContext, HarnessError>
}

/** STRATEGY: how memory is kept, compacted and rebuilt. Swap this plugin to swap memory. */
export class ConversationMemory extends Context.Tag("efferent/ConversationMemory")<ConversationMemory, {
  readonly strategy: { readonly id: string; readonly version: string }
  /** `services` are the turn's: a strategy reads what it needs (a summarizer, a digester) here. */
  readonly open: (scope: {
    readonly conversation: ConversationId
    readonly runId: string
    readonly io: JournalIO
    readonly services: Context.Context<never>
  }) => Effect.Effect<MemorySession, HarnessError, Scope.Scope>
}>() {}
