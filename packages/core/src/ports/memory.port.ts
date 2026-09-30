import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { AgentMessage, ConversationId } from "../domain/message.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { LogQuery } from "../memory/memory-log.entity.functions.js"
import type { ArtifactRef, BuiltContext, EntryId, LogBody, LogEntry, Subject } from "../memory/memory-log.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"

/** A conversation's memory log for one turn: the entries stored before it, and one atomic append. */
export interface LogHandle {
  readonly read: Effect.Effect<ReadonlyArray<LogEntry>, HarnessError>
  readonly append: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<void, HarnessError>
}

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
  /** The user message the digest must serve. */
  readonly userMessage: UserMessage
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
  readonly digest: (tool: string, encoded: unknown, params: unknown, userMessage: UserMessage) => Effect.Effect<Option.Option<DigestTask>>
}

/** Runs a tool's digest prompt (see `DigestDefinition`). Read, when present, from where the session is opened. */
export class ResultDigester extends Context.Service<ResultDigester, {
  readonly id: string
  readonly version: string
  readonly digest: (task: DigestTask) => Effect.Effect<DigestOutcome, HarnessError>
}>()("efferent/ResultDigester") {}

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
export class ConversationMemory extends Context.Service<ConversationMemory, {
  readonly strategy: { readonly id: string; readonly version: string }
  /**
   * Open the conversation's session for one run over its log (the turn's
   * memory events). A strategy reads what it needs per turn (a
   * ResultDigester, a summarizer's UtilityLlm) with `Effect.serviceOption`
   * from the environment it is opened in.
   */
  readonly open: (scope: {
    readonly conversation: ConversationId
    readonly runId: string
    readonly log: LogHandle
  }) => Effect.Effect<MemorySession, HarnessError, Scope.Scope>
}>()("efferent/ConversationMemory") {}
