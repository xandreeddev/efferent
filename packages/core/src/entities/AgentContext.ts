import { Schema } from "effect"
import { ConversationId } from "./Conversation.js"

/** Identity of a node in the branching agent-context tree. */
export const ContextNodeId = Schema.UUID.pipe(Schema.brand("ContextNodeId"))
export type ContextNodeId = typeof ContextNodeId.Type

/**
 * How a node's context was seeded. This is a **descriptor only** — the actual
 * seed messages live in the node's `context_messages` rows (so we never store a
 * full `AgentMessage[]` twice). `preview` is a short, display-only truncation
 * for the tree UI; `sourceNodeId` records the node a selection/handoff was
 * drawn from, when there is one.
 */
export const ContextSeed = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("task"),
    preview: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("selection"),
    sourceNodeId: Schema.optional(ContextNodeId),
    turnCount: Schema.Number,
    preview: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("handoff"),
    sourceNodeId: Schema.optional(ContextNodeId),
    preview: Schema.optional(Schema.String),
  }),
)
export type ContextSeed = typeof ContextSeed.Type

/**
 * Provenance of a node relative to its parent:
 * - `spawned` — started fresh from a (possibly running) parent context.
 * - `branched` — a new run seeded from a finished node's *resulting* context.
 * - `resumed` — recorded when a node is continued in place (same node id keeps
 *   growing; an explicit edge is emitted for browse history).
 */
export const EdgeKind = Schema.Literal("spawned", "branched", "resumed")
export type EdgeKind = typeof EdgeKind.Type

export const ContextNodeStatus = Schema.Literal("running", "ok", "error")
export type ContextNodeStatus = typeof ContextNodeStatus.Type

/** Cumulative token usage for a node's run — mirrors `AgentSubAgentEndEvent.usage`. */
export const ContextUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
})
export type ContextUsage = typeof ContextUsage.Type

/**
 * One node in the persistent, branching agent-context tree: a single scoped
 * agent run with its own message history (stored separately), its provenance
 * edge to a parent, the folder it was sandboxed to, and — once finished — its
 * return summary, files changed, and usage. The tree is reconstructed from the
 * flat `parentId` chain (see `ContextTreeStore.listTree`).
 */
export const AgentContextNode = Schema.Struct({
  id: ContextNodeId,
  /** null = a root node (spawned directly by the human or top-level agent). */
  parentId: Schema.NullOr(ContextNodeId),
  /** The human conversation this whole tree hangs off — browse scoping. */
  rootConversationId: Schema.NullOr(ConversationId),
  edgeKind: EdgeKind,
  /** Absolute scope dir: writes/bash are confined here. */
  folder: Schema.String,
  /** Workspace anchor used to rebuild the `ScopeBinding` (relative-path display). */
  displayRoot: Schema.String,
  seed: ContextSeed,
  /**
   * How many of this node's messages were materialized at spawn (positions
   * `0..n-1` = the seed; the run's appended tail follows). Lets a viewer mark
   * the seed/run boundary. Absent on rows created before the column existed.
   */
  seedMessageCount: Schema.optional(Schema.Number),
  status: ContextNodeStatus,
  returnSummary: Schema.optional(Schema.String),
  filesChanged: Schema.Array(Schema.String),
  usage: Schema.optional(ContextUsage),
  /**
   * The workspace git ref (HEAD) when this node's run finished — the world its
   * context describes. A later resume/branch compares it against the current
   * HEAD: if they differ, the node is **stale** (its in-context file reads may
   * no longer match the tree) and the spawner injects a staleness brief.
   * Absent on running nodes and non-git workspaces.
   */
  workspaceRef: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  endedAt: Schema.optional(Schema.Number),
})
export type AgentContextNode = typeof AgentContextNode.Type
