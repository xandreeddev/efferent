import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { MediaSlot } from "../domain/media.entity.js"
import type { AgentMessage, ConversationId } from "../domain/message.entity.js"
import type { RunId, RunOrdinal } from "../domain/run.entity.js"
import type { TokenUsage } from "../domain/token-usage.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { ArtifactRef, BuiltContext, EntryId, LogBody, LogEntry, LogQuery, Subject } from "../memory/memory-log.entity.js"
import type { TurnError } from "../session/sessions.entity.js"
import type { UserMessage } from "../turn/user-message.entity.js"
import type { MemoryRenderRecipe } from "../turn/model-request.entity.js"

/** A conversation's memory log for one turn: the entries stored before it, and one atomic append. */
export interface LogHandle {
  readonly read: Effect.Effect<ReadonlyArray<LogEntry>, TurnError>
  readonly append: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<void, TurnError>
  /** Fresh durable entries after a write's outcome is uncertain; `read` supplies this for logs whose initial read is already current. */
  readonly snapshot?: Effect.Effect<ReadonlyArray<LogEntry>, TurnError>
}

/** One tool result as the model sees it, supplied by whoever owns the tools. */
export interface ToolView {
  readonly text: string
  readonly version: string
  readonly subjects: ReadonlyArray<Subject>
  readonly artifacts: ReadonlyArray<ArtifactRef>
  readonly pinned: boolean
  /**
   * The images of the encoded result the model is sent with it, where they
   * are in it (`mediaSlotsOf`). Memory checks each one when it records the
   * result (`toolResultMedia`): an image that fails, or one over
   * `MEDIA_LIMITS.toolResultImages`, is a label line in the stored view.
   */
  readonly media?: ReadonlyArray<MediaSlot>
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
  /**
   * Summarize mode: the identifiers the summary must contain verbatim, or
   * `apply` refuses it (empty in select mode, which keeps whole items).
   * The digester shows them to its model.
   */
  readonly preserve: ReadonlyArray<string>
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

/**
 * Read-only memory for tools, sections, matchers and reactions.
 *
 * @public
 */
export interface MemoryReader {
  readonly turn: Effect.Effect<number>
  /** The append-only raw log; query and resolve apply any later ToolPresentation metadata. */
  readonly entries: Effect.Effect<ReadonlyArray<LogEntry>>
  readonly query: (query: LogQuery) => Effect.Effect<ReadonlyArray<LogEntry>>
  readonly subjects: (kinds: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Subject>>
  readonly resolve: (id: EntryId) => Effect.Effect<Option.Option<LogEntry>>
  readonly transcript: (fidelity: "raw" | "model" | "reference") => Effect.Effect<ReadonlyArray<AgentMessage>>
}

/** @public */
export interface MaintainSignal {
  readonly phase: "turn-start" | "step"
  readonly lastUsage: Option.Option<TokenUsage>
  /**
   * Tokens available to the messages, at least 1: at `step`, what the system
   * prompt and the active tool schemas leave of the run's budget; at
   * `turn-start`, the run's whole budget (nothing is built yet).
   */
  readonly budgetTokens: number
  readonly views: ToolViews
}

export interface MemorySession extends MemoryReader {
  readonly strategy: { readonly id: string; readonly version: string }
  /**
   * The pure render recipe of this session for run `run` of the turn (its
   * step context is that run's), saved with every outgoing request for
   * version-independent replay.
   */
  readonly renderRecipe: (stepContext: "tail" | "none", run: RunOrdinal) => Effect.Effect<MemoryRenderRecipe>
  /**
   * Allocate and record bodies in order. An alternate atomic commit sees
   * the prepared entries under the same allocation lock: true commits the
   * whole batch, false records nothing and consumes no ids. A failed
   * acknowledgement reconciles from the durable snapshot before another
   * allocation, preserving the original error.
   */
  readonly record: (bodies: ReadonlyArray<LogBody>, step: number, commit?: (entries: ReadonlyArray<LogEntry>) => Effect.Effect<boolean, TurnError>) => Effect.Effect<ReadonlyArray<LogEntry>, TurnError>
  /** Store raw messages/results before host views, then append presentation metadata and optional digests. The optional run ordinal disambiguates concurrent runs. */
  readonly recordTail: (tail: ReadonlyArray<AgentMessage>, views: ToolViews, step: number, run?: RunOrdinal) => Effect.Effect<ReadonlyArray<LogEntry>, TurnError>
  /** The only place compaction is decided; the decision is recorded before it applies. */
  readonly maintain: (signal: MaintainSignal) => Effect.Effect<ReadonlyArray<LogEntry>, TurnError>
  /**
   * A pure fold of the log: what the next request of run `run` of the turn
   * sends, its step context that run's latest (never an earlier run's).
   */
  readonly build: (request: { readonly stepContext: "tail" | "none"; readonly run: RunOrdinal }) => Effect.Effect<BuiltContext, HarnessError>
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
    readonly runId: RunId
    readonly log: LogHandle
  }) => Effect.Effect<MemorySession, TurnError, Scope.Scope>
}>()("efferent/ConversationMemory") {}
