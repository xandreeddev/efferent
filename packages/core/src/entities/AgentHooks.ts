import type { Effect } from "effect"
import type { TokenUsage } from "../ports/LlmInfo.js"
import type { ContextNodeId } from "./AgentContext.js"
import type { AgentMessage, ToolCall } from "./Conversation.js"

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

export interface AgentAssistantMessageEvent {
  readonly turnIndex: number
  readonly text: string
  /** The model's externalised reasoning for this step, when surfaced. */
  readonly reasoning?: string
  readonly toolCalls: ReadonlyArray<ToolCall>
  readonly usage?: TokenUsage
  /** Set when this message belongs to a sub-agent run: its context-tree node
   *  id — lets a consumer attribute interleaved parallel runs correctly. */
  readonly subAgentNodeId?: ContextNodeId
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
}

export interface AgentSubAgentStartEvent {
  readonly name: string
  readonly task: string
  /** The persisted context-tree node id for this sub-agent run, when one exists. */
  readonly nodeId?: ContextNodeId
  /** The parent node's id, for nesting under an enclosing sub-agent's container. */
  readonly parentNodeId?: ContextNodeId
}

export interface AgentSubAgentEndEvent {
  readonly name: string
  /** The persisted context-tree node id for this sub-agent run, when one exists. */
  readonly nodeId?: ContextNodeId
  readonly ok: boolean
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

/** A helper-tier (fast/cheap) call ran inside the loop — e.g. a headroom
 *  middle-summary. Reported so the driver's ledger can count every tier. */
export interface AgentHelperUsageEvent {
  readonly role: "fast" | "cheap"
  readonly usage: TokenUsage
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
}
