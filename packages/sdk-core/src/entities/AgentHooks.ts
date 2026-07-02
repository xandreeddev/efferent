import type { Effect } from "effect"
import type { TokenUsage } from "./TokenUsage.js"
import type { ContextNodeId } from "./AgentContext.js"
import type { AgentMessage, ToolCall } from "./Conversation.js"
import type { AgentModelRole } from "./Model.js"
import type { OutcomeStatus, StopReasonKind } from "./Outcome.js"

/**
 * Decision returned by `onBeforeToolCall`: either let the call proceed
 * or block it with a reason that's reported back to the model as a
 * tool result.
 */
export type BeforeToolCallDecision =
  | { readonly action: "continue" }
  | { readonly action: "block"; readonly reason: string }

export interface AgentTurnStartEvent {
  readonly turnIndex: number
  readonly messages: ReadonlyArray<AgentMessage>
}

/** The user's prompt opening a turn — fired by the loop after the message is
 *  persisted, carrying its absolute store `position` so the UI keys the rail's
 *  user block on a durable, handoff-stable identity. */
export interface AgentUserMessageEvent {
  readonly turnIndex: number
  readonly text: string
  /** The message's absolute store position (the rail's block key). */
  readonly position?: number
  /** Set when this is a sub-agent's seed/user message. */
  readonly subAgentNodeId?: ContextNodeId
}

export interface AgentAssistantMessageEvent {
  readonly turnIndex: number
  readonly text: string
  /** The model's externalised reasoning for this step, when surfaced. */
  readonly reasoning?: string
  readonly toolCalls: ReadonlyArray<ToolCall>
  readonly usage?: TokenUsage
  /** The assistant message's absolute store position — the rail's block key, so
   *  a live block and the later DB-projected block reconcile. Absent when the
   *  caller didn't persist (the eval/direct path provides no `onTail`). */
  readonly position?: number
  /** Set when this message belongs to a sub-agent run: its context-tree node
   *  id — lets a consumer attribute interleaved parallel runs correctly. */
  readonly subAgentNodeId?: ContextNodeId
  /** The sub-agent's model role (`general` | `code`) — so its spend lands on the
   *  right tier in the ledger. Set only for sub-agent messages. */
  readonly subAgentRole?: AgentModelRole
}

export interface AgentBeforeToolCallEvent {
  readonly turnIndex: number
  /** Provider tool-call id — pairs this start with its end (distinguishes two
   *  same-named calls in one turn). Empty when the provider omits one. */
  readonly toolCallId: string
  readonly toolName: string
  readonly args: unknown
  /** The sub-agent (context-tree node id) this call runs inside, if any. */
  readonly subAgentNodeId?: ContextNodeId
}

export interface AgentAfterToolCallEvent {
  readonly turnIndex: number
  /** Matches the originating {@link AgentBeforeToolCallEvent.toolCallId}. */
  readonly toolCallId: string
  readonly toolName: string
  readonly args: unknown
  readonly ok: boolean
  readonly result: unknown
  /** The sub-agent (context-tree node id) this call ran inside, if any. */
  readonly subAgentNodeId?: ContextNodeId
}

export interface AgentShouldStopEvent {
  readonly turnIndex: number
  readonly finishReason: string
}

export interface AgentEndEvent {
  readonly messages: ReadonlyArray<AgentMessage>
  readonly finalText: string
  /** How the ROOT turn ended (see `entities/Outcome.ts`). Absent from legacy
   *  emitters ⇒ consumers treat it as `ok`. */
  readonly outcome?: OutcomeStatus
  /** WHY it ended, when not simply completed (`step-cap`, `interrupt`, …). */
  readonly reason?: StopReasonKind
}

export interface AgentSubAgentStartEvent {
  readonly name: string
  readonly task: string
  /** The persisted context-tree node id for this sub-agent run, when one exists. */
  readonly nodeId?: ContextNodeId
  /** The parent node's id, for nesting under an enclosing sub-agent's container. */
  readonly parentNodeId?: ContextNodeId
  /** The model role this sub-agent runs as (`general` | `code`) — surfaced so the
   *  UI can show the active tier when this agent is focused. */
  readonly role?: AgentModelRole
}

export interface AgentSubAgentEndEvent {
  readonly name: string
  /** The persisted context-tree node id for this sub-agent run, when one exists. */
  readonly nodeId?: ContextNodeId
  /** Legacy boolean — `outcome ∈ {ok, partial}`. Kept so a stale daemon/client
   *  pair still agrees; new consumers read `outcome ?? (ok ? "ok" : "error")`. */
  readonly ok: boolean
  /** How the run ended: ok | partial | error | killed (see `entities/Outcome.ts`).
   *  THE terminal signal — emitted on EVERY exit shape by `finalizeRun`. */
  readonly outcome?: OutcomeStatus
  /** WHY it ended, when not simply completed (`budget`, `stall`, `interrupt`, …). */
  readonly reason?: StopReasonKind
  readonly summary: string
  readonly filesChanged: ReadonlyArray<string>
  /** Cumulative token usage across all turns of this sub-agent's run. Optional — only present when the sub-agent had at least one LLM turn. */
  readonly usage?: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly cacheReadTokens: number
  }
}

export interface AgentSkillLoadEvent {
  readonly name: string
}

/** A fast-tier helper call ran inside the loop — e.g. a compaction
 *  middle-summary or session title. Reported so the driver's ledger can
 *  count helper spend separately from main. */
export interface AgentHelperUsageEvent {
  readonly role: "fast"
  readonly usage: TokenUsage
}

/**
 * A transient LLM failure (rate-limit / overload / transport) is being retried
 * with backoff — emitted by `retryableLlm` (the adapter) so the UI can show the
 * wait instead of a silent hang. `attempt`/`maxAttempts` are 1-based; `delayMs`
 * is the (already-clamped) wait before the next try; `reason` is a short label
 * (`"HTTP 429"`, `"HttpRequestError"`).
 */
export interface AgentLlmRetryEvent {
  readonly reason: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly delayMs: number
  /** The sub-agent (context-tree node id) whose call is retrying — stamped by
   *  the spawned run's sink so the UI attributes the storm to the agent, not
   *  the root rail. Absent = the root's own call. */
  readonly nodeId?: string
}

/**
 * A chunk of output from a BACKGROUND shell process (one started with
 * `run_in_background`, which outlives the spawning tool call). Emitted by the
 * Shell adapter's drain loop — like {@link AgentLlmRetryEvent}, it surfaces work
 * that happens BELOW the loop, so a long-running background process is visible
 * live in the rail instead of silent until the next `bash_output` poll.
 */
export interface AgentBgOutputEvent {
  readonly processId: string
  readonly stream: "stdout" | "stderr"
  readonly chunk: string
}

/**
 * The mandatory swarm gate produced a verdict on the finished objective (see
 * `driveLoop`). Emitted once per gate round whenever a run used sub-agents, so the
 * verification is never silent: `sound` (shipped), `needs_work`/`blocked` (the
 * deliverable was rejected — `reasons` say why; the loop learns + retries), or
 * `unavailable` (no `claude`/verifier error — the run proceeds, loudly unverified,
 * never silently passed). `attempt` is 1-based.
 */
export interface AgentGateEvent {
  readonly verdict: "sound" | "needs_work" | "blocked" | "unavailable"
  readonly reasons: ReadonlyArray<string>
  readonly attempt: number
  readonly filesChanged: ReadonlyArray<string>
  /**
   * The verdict was not `sound`, but the deliverable was **delivered anyway** with
   * these `reasons` as advisory notes — because it's a research/prose deliverable
   * (no files changed), where a `needs_work` is the reviewer's opinion, not a hard
   * failure. The fail-closed retry-to-cap loop only runs for file-changing (code)
   * deliverables; a prose deliverable is delivered-with-notes, never re-run. The UI
   * renders an advisory verdict as notes rather than a red failure.
   */
  readonly advisory?: boolean
}

/**
 * Hook surface that lets the application (and the route layer above it)
 * observe and influence the agent loop without owning the loop itself.
 *
 * Modeled after Pi's `AgentLoopConfig` callbacks (`transformContext`,
 * `prepareNextTurn`, `shouldStopAfterTurn`, plus event emission). Every
 * hook is optional; `R` is the union of port requirements each hook's
 * Effect needs — it flows up to the caller through `Llm.runAgent`'s
 * generic signature.
 */
export interface AgentHooks<R = never> {
  readonly onTurnStart?: (event: AgentTurnStartEvent) => Effect.Effect<void, never, R>
  readonly onUserMessage?: (
    event: AgentUserMessageEvent,
  ) => Effect.Effect<void, never, R>
  readonly onAssistantMessage?: (
    event: AgentAssistantMessageEvent,
  ) => Effect.Effect<void, never, R>
  readonly onBeforeToolCall?: (
    event: AgentBeforeToolCallEvent,
  ) => Effect.Effect<BeforeToolCallDecision, never, R>
  readonly onAfterToolCall?: (
    event: AgentAfterToolCallEvent,
  ) => Effect.Effect<void, never, R>
  readonly onTransformContext?: (
    messages: ReadonlyArray<AgentMessage>,
  ) => Effect.Effect<ReadonlyArray<AgentMessage>, never, R>
  readonly onShouldStopAfterTurn?: (
    event: AgentShouldStopEvent,
  ) => Effect.Effect<boolean, never, R>
  readonly onAgentEnd?: (event: AgentEndEvent) => Effect.Effect<void, never, R>
  readonly onSubAgentStart?: (
    event: AgentSubAgentStartEvent,
  ) => Effect.Effect<void, never, R>
  readonly onSubAgentEnd?: (
    event: AgentSubAgentEndEvent,
  ) => Effect.Effect<void, never, R>
  readonly onSkillLoad?: (
    event: AgentSkillLoadEvent,
  ) => Effect.Effect<void, never, R>
  readonly onHelperUsage?: (
    event: AgentHelperUsageEvent,
  ) => Effect.Effect<void, never, R>
  /**
   * The mandatory swarm gate returned a verdict (see {@link AgentGateEvent}).
   * Fired by `driveLoop` after the swarm objective finishes, once per gate round.
   */
  readonly onGateResult?: (
    event: AgentGateEvent,
  ) => Effect.Effect<void, never, R>
  /**
   * A transient LLM failure is being retried. UNLIKE every other hook, this one
   * is `R = never` (self-contained): it's invoked from the provider adapter
   * (`retryableLlm`, below the loop), whose fiber carries the LLM's own
   * requirements, NOT the loop's `R`. So it must need nothing — the driver wires
   * it to a plain queue/PubSub publish. Threaded to the adapter via
   * `RunContext.onLlmRetry` (a FiberRef), not called by the loop directly.
   */
  readonly onLlmRetry?: (event: AgentLlmRetryEvent) => Effect.Effect<void>
  /**
   * A background shell process emitted output. Same `R = never` contract as
   * {@link onLlmRetry} — invoked from the Shell adapter's drain fiber (below the
   * loop), threaded via `RunContext.onBgOutput`, wired by the driver to a plain
   * queue/PubSub publish.
   */
  readonly onBgOutput?: (event: AgentBgOutputEvent) => Effect.Effect<void>
}
