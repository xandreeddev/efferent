import { Schema } from "effect"
import { AgentMessage } from "./Conversation.js"

/**
 * The mode-agnostic event vocabulary the agent loop emits via hooks — and, once
 * the daemon split lands, the **wire payload** every transport carries. It lived
 * as a hand-written TS union in `@xandreed/code`'s `events.ts`; it's a
 * `Schema.Union` here so the same shape serves three masters: the loop's hooks
 * (`makeEventHooks`), the JSON modes (json/rpc), and the HTTP/SSE transport
 * (`subscribe` → `Stream<SeqEvent>`). `events.ts` re-exports it, so the loop
 * side is unchanged.
 *
 * `nodeId`/`parentNodeId` are plain strings, NOT the `ContextNodeId` brand: this
 * is the cross-process wire vocabulary, so the brand stays in the domain and the
 * transport stays a plain string (the original `events.ts` made the same call).
 */
const TokenUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  totalTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
})

/** Sub-agent cumulative usage omits `totalTokens` (mirrors `AgentSubAgentEndEvent.usage`). */
const SubAgentUsage = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
})

export const AgentEvent = Schema.Union(
  // Internal drain sentinel: offered by a mode AFTER its run completes so the
  // consumer fiber exits its loop having rendered everything before it. Never
  // serialized to stdout/stderr/RPC/SSE.
  Schema.Struct({ type: Schema.Literal("flush") }),
  Schema.Struct({
    type: Schema.Literal("turn_start"),
    turnIndex: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("assistant_message"),
    turnIndex: Schema.Number,
    text: Schema.String,
    reasoning: Schema.optional(Schema.String),
    usage: Schema.optional(TokenUsage),
    /** Set for sub-agent narration: the run's context-tree node id. */
    nodeId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call_start"),
    turnIndex: Schema.Number,
    /** Provider tool-call id — pairs start↔end exactly. May be empty. */
    id: Schema.String,
    toolName: Schema.String,
    args: Schema.Unknown,
    nodeId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_call_end"),
    turnIndex: Schema.Number,
    id: Schema.String,
    toolName: Schema.String,
    ok: Schema.Boolean,
    result: Schema.Unknown,
    nodeId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("subagent_start"),
    name: Schema.String,
    task: Schema.String,
    nodeId: Schema.optional(Schema.String),
    /** The parent node's id — nests this run under its enclosing sub-agent. */
    parentNodeId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("subagent_end"),
    name: Schema.String,
    nodeId: Schema.optional(Schema.String),
    ok: Schema.Boolean,
    summary: Schema.String,
    filesChanged: Schema.Array(Schema.String),
    usage: Schema.optional(SubAgentUsage),
  }),
  Schema.Struct({
    type: Schema.Literal("skill_load"),
    name: Schema.String,
  }),
  Schema.Struct({
    /** A fast-tier helper call ran inside the loop (compaction digest, title). */
    type: Schema.Literal("helper_usage"),
    role: Schema.Literal("fast"),
    usage: TokenUsage,
  }),
  Schema.Struct({
    type: Schema.Literal("agent_end"),
    finalText: Schema.String,
    messages: Schema.Array(AgentMessage),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
  }),
  // The agent is parked on a bash-approval request — the daemon publishes this
  // so every attached client renders the sheet; a client answers with
  // `Workspace.approve` (POST /approve). `sessionId` is the asking session.
  Schema.Struct({
    type: Schema.Literal("approval_needed"),
    sessionId: Schema.optional(Schema.String),
    tool: Schema.String,
    summary: Schema.String,
    cwd: Schema.String,
    ruleKey: Schema.String,
    reason: Schema.optional(Schema.String),
    folder: Schema.optional(Schema.String),
  }),
  // The pending approval was answered (by some client) — clears stale sheets
  // on every other client.
  Schema.Struct({
    type: Schema.Literal("approval_resolved"),
    sessionId: Schema.optional(Schema.String),
  }),
)
export type AgentEvent = typeof AgentEvent.Type
