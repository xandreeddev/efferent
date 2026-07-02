import { Schema } from "effect"
import { ConversationId } from "./Conversation.js"
import { StopReason } from "./Outcome.js"

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

/**
 * A node's live/terminal status — `running` plus the honest terminal vocabulary
 * (see `entities/Outcome.ts`): `ok` (complete) · `partial` (a deliverable
 * exists but the run stopped early — budget / step-cap / stall-after-text) ·
 * `error` (the run failed) · `killed` (interrupted or stalled with nothing
 * produced). Old rows only ever carry running/ok/error — no data migration.
 */
export const ContextNodeStatus = Schema.Literal(
  "running",
  "ok",
  "partial",
  "error",
  "killed",
)
export type ContextNodeStatus = typeof ContextNodeStatus.Type

/** Statuses a finished node can carry (everything but `running`). */
export const TERMINAL_NODE_STATUSES = ["ok", "partial", "error", "killed"] as const
export type TerminalNodeStatus = (typeof TERMINAL_NODE_STATUSES)[number]

/**
 * The tier a context node occupies, making the SESSION → FLEET → AGENT model
 * explicit instead of implied by `parentId`:
 * - `fleet` — a top-level node under a session (`parentId === null`): a task /
 *   coordinator the session dispatched.
 * - `agent` — a deeper worker node (`parentId` set) within a fleet.
 *
 * A session itself is a `conversations` row, not a context node. The column is
 * nullable on rows created before it existed; {@link nodeKind} derives the tier
 * from `parentId` when `kind` is absent.
 */
export const NodeKind = Schema.Literal("fleet", "agent")
export type NodeKind = typeof NodeKind.Type

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
  /**
   * The node's tier in the SESSION → FLEET → AGENT model — `fleet` for a
   * top-level node under a session, `agent` for a deeper worker. Absent on rows
   * created before the column existed; use {@link nodeKind} to read it (which
   * derives the tier from `parentId` when this is undefined).
   */
  kind: Schema.optional(NodeKind),
  /** The human conversation this whole tree hangs off — browse scoping. */
  rootConversationId: Schema.NullOr(ConversationId),
  edgeKind: EdgeKind,
  /** Absolute scope dir: writes/bash are confined here. */
  folder: Schema.String,
  /** Workspace anchor used to rebuild the `ScopeBinding` (relative-path display). */
  displayRoot: Schema.String,
  /**
   * Short display name the spawner gave this agent ("audit state layer") —
   * what every UI surface shows instead of the folder basename, which reads
   * as triplicate noise the moment two agents share a folder. Absent on rows
   * created before the column existed.
   */
  title: Schema.optional(Schema.String),
  seed: ContextSeed,
  /**
   * How many of this node's messages were materialized at spawn (positions
   * `0..n-1` = the seed; the run's appended tail follows). Lets a viewer mark
   * the seed/run boundary. Absent on rows created before the column existed.
   */
  seedMessageCount: Schema.optional(Schema.Number),
  status: ContextNodeStatus,
  returnSummary: Schema.optional(Schema.String),
  /**
   * WHY the run stopped (typed — budget / step-cap / stall / interrupt /
   * provider / error; see `entities/Outcome.ts`). Written by the one terminal
   * path; absent on running nodes and rows created before the column existed.
   */
  stopReason: Schema.optional(StopReason),
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

/**
 * The node's tier, derived: the explicit `kind` if present, else inferred from
 * `parentId` (a root node is a `fleet`, a child is an `agent`). The single
 * source of truth every reader should use — never branch on `parentId`
 * directly, so the rule stays in one place.
 */
export const nodeKind = (node: {
  readonly kind?: NodeKind | undefined
  readonly parentId: ContextNodeId | null
}): NodeKind => node.kind ?? (node.parentId === null ? "fleet" : "agent")
