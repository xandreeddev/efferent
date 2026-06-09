import { Context, Data, type Effect } from "effect"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import type {
  AgentContextNode,
  ContextNodeId,
  ContextSeed,
  ContextUsage,
  EdgeKind,
} from "../entities/AgentContext.js"

export class ContextTreeStoreError extends Data.TaggedError(
  "ContextTreeStoreError",
)<{
  readonly cause: unknown
  readonly message: string
}> {}

export class ContextNodeNotFound extends Data.TaggedError(
  "ContextNodeNotFound",
)<{
  readonly id: string
}> {}

/** Inputs to {@link ContextTreeStore.spawn} — a new node plus its seed messages. */
export interface SpawnInput {
  readonly parentId: ContextNodeId | null
  readonly rootConversationId: ConversationId | null
  readonly edgeKind: EdgeKind
  readonly folder: string
  readonly displayRoot: string
  readonly seed: ContextSeed
  /** The materialized seed messages (selection verbatim / [handoffToMessage] / [task]). */
  readonly seedMessages: ReadonlyArray<AgentMessage>
}

/** Fields written when a node's run finishes — see {@link ContextTreeStore.recordReturn}. */
export interface ContextReturn {
  readonly status: "ok" | "error"
  readonly summary: string
  readonly filesChanged: ReadonlyArray<string>
  readonly usage?: ContextUsage
  readonly endedAt: number
}

/**
 * Persistence for the branching agent-context tree — a dedicated store, separate
 * from {@link ConversationStore}: each node is one scoped sub-agent run with its
 * own message history and a `parentId` edge. The TUI browses the tree, and the
 * agent (or human) spawns / resumes / branches over it.
 */
export class ContextTreeStore extends Context.Tag(
  "@efferent/core/ContextTreeStore",
)<
  ContextTreeStore,
  {
    /** Create a `running` node and materialize its seed messages at positions 0.. */
    readonly spawn: (
      input: SpawnInput,
    ) => Effect.Effect<ContextNodeId, ContextTreeStoreError>
    /** Append one message to a node's own history (position = max+1). */
    readonly append: (
      id: ContextNodeId,
      msg: AgentMessage,
    ) => Effect.Effect<void, ContextTreeStoreError | ContextNodeNotFound>
    /** The node's full message history in position order (seed + appended tail). */
    readonly listMessages: (
      id: ContextNodeId,
    ) => Effect.Effect<ReadonlyArray<AgentMessage>, ContextTreeStoreError>
    /** Close a node: set status/summary/filesChanged/usage/endedAt. */
    readonly recordReturn: (
      id: ContextNodeId,
      result: ContextReturn,
    ) => Effect.Effect<void, ContextTreeStoreError | ContextNodeNotFound>
    readonly get: (
      id: ContextNodeId,
    ) => Effect.Effect<AgentContextNode, ContextTreeStoreError | ContextNodeNotFound>
    /**
     * All nodes for one root conversation, flat (the TUI builds the parent/child
     * structure from `parentId`). A `null` root returns nodes with no
     * `rootConversationId` (detached/standalone trees).
     */
    readonly listTree: (
      rootConversationId: ConversationId | null,
    ) => Effect.Effect<ReadonlyArray<AgentContextNode>, ContextTreeStoreError>
    /** Delete a node and its descendants + messages (FK cascade). */
    readonly drop: (
      id: ContextNodeId,
    ) => Effect.Effect<void, ContextTreeStoreError>
  }
>() {}
