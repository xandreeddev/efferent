import { Schema } from "effect"
import { OutcomeStatus, StopReasonKindSchema } from "./Outcome.js"

/**
 * The mode-agnostic event vocabulary the agent loop emits via hooks — and, once
 * the daemon split lands, the **wire payload** every transport carries. It lived
 * as a hand-written TS union in `efferent`'s `events.ts`; it's a
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
  // The user's prompt for a turn — emitted by the loop right after it persists
  // the message, so the rail's user line flows through the SAME keyed stream as
  // everything else (the daemon used to emit no user event, which forced a
  // fragile queue-diff reconstruction client-side). `position` is the message's
  // absolute store position — the rail keys the user block on it so an optimistic
  // line and this authoritative one reconcile to one entry.
  Schema.Struct({
    type: Schema.Literal("user_message"),
    turnIndex: Schema.Number,
    text: Schema.String,
    position: Schema.optional(Schema.Number),
    /** Set for a sub-agent's seed/user message: the run's context-tree node id. */
    nodeId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("assistant_message"),
    turnIndex: Schema.Number,
    text: Schema.String,
    reasoning: Schema.optional(Schema.String),
    usage: Schema.optional(TokenUsage),
    /** The assistant message's absolute store position — the rail keys its
     *  text/reasoning blocks on it so a replayed/re-projected message upserts
     *  in place instead of duplicating. Absent on the eval/direct path. */
    position: Schema.optional(Schema.Number),
    /** Set for sub-agent narration: the run's context-tree node id. */
    nodeId: Schema.optional(Schema.String),
    /** Set for sub-agent narration: the run's model role (`general` | `code`),
     *  so its spend lands on the right tier in the ledger. */
    subAgentRole: Schema.optional(Schema.Literal("general", "code")),
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
    /** The model role this run uses (`general` | `code`) — for the active-tier UI. */
    role: Schema.optional(Schema.Literal("general", "code")),
  }),
  // THE terminal signal for a sub-agent run — emitted on EVERY exit shape by
  // `finalizeRun` (ok / partial / error / killed), never skipped. `ok` is the
  // legacy boolean (`outcome ∈ {ok, partial}`) kept for stale daemon/client
  // pairs; consumers read `outcome ?? (ok ? "ok" : "error")`. `reason` is the
  // compact WHY label (budget / step-cap / stall / interrupt / …).
  Schema.Struct({
    type: Schema.Literal("subagent_end"),
    name: Schema.String,
    nodeId: Schema.optional(Schema.String),
    ok: Schema.Boolean,
    outcome: Schema.optional(OutcomeStatus),
    reason: Schema.optional(StopReasonKindSchema),
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
    /** The turn-boundary distiller persisted reusable lessons (skills/constraints/
     *  memory) the next run will inherit — emitted on every run path so the
     *  self-improving loop's "learn for next time" step is visible. */
    type: Schema.Literal("learned"),
    lessons: Schema.Array(
      Schema.Struct({ name: Schema.String, kind: Schema.String }),
    ),
  }),
  // The mandatory swarm gate validated (or rejected) the finished objective —
  // emitted once per gate round whenever a run used sub-agents, so verification is
  // never silent. `sound` ships; `needs_work`/`blocked` carry the reasons the loop
  // learns from + retries on; `unavailable` means no verdict was possible (no
  // `claude`) and the run proceeded LOUDLY unverified, never a silent pass.
  Schema.Struct({
    type: Schema.Literal("gate"),
    verdict: Schema.Literal("sound", "needs_work", "blocked", "unavailable"),
    reasons: Schema.Array(Schema.String),
    attempt: Schema.Number,
    filesChanged: Schema.Array(Schema.String),
    // A non-sound verdict on a research/prose deliverable (no files changed) that
    // was DELIVERED anyway with these reasons as advisory notes — not fail-closed.
    // The UI renders it as notes, not a red failure.
    advisory: Schema.optional(Schema.Boolean),
  }),
  // The root turn's terminal event. `messages` is GONE from the wire — it had
  // zero consumers and could be megabytes per turn on SSE. `outcome`/`reason`
  // carry root honesty (a step-capped root is `partial`, an interrupted one
  // `killed` — never a silent "success").
  Schema.Struct({
    type: Schema.Literal("agent_end"),
    finalText: Schema.String,
    outcome: Schema.optional(OutcomeStatus),
    reason: Schema.optional(StopReasonKindSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    message: Schema.String,
  }),
  // A transient LLM failure (rate-limit / overload / transport) is being retried
  // with backoff — surfaced so a wait shows up live instead of a silent hang.
  // `attempt`/`maxAttempts` are 1-based; `delayMs` is the (clamped) wait.
  // `nodeId` attributes a SUB-AGENT's retry storm to its node (absent = root).
  Schema.Struct({
    type: Schema.Literal("llm_retry"),
    reason: Schema.String,
    attempt: Schema.Number,
    maxAttempts: Schema.Number,
    delayMs: Schema.Number,
    nodeId: Schema.optional(Schema.String),
  }),
  // A running agent's live health — EDGE-TRIGGERED (state transitions + a
  // ≥15s activity re-stamp), never a heartbeat. Published by the bus sink, so
  // it covers arbitrarily nested runs on every driver. The client computes
  // staleness itself from `lastActivityAt`.
  Schema.Struct({
    type: Schema.Literal("agent_health"),
    nodeId: Schema.String,
    state: Schema.Literal(
      "starting",
      "generating",
      "tool-running",
      "retrying",
      "awaiting-approval",
      "waiting-on-agents",
    ),
    lastActivityAt: Schema.Number,
    detail: Schema.optional(Schema.String),
    /** Billed tokens so far (input+output), when known. */
    tokens: Schema.optional(Schema.Number),
  }),
  // A chunk of output from a background shell process (`run_in_background`) —
  // surfaced live so a long-running background command is visible in the rail
  // instead of silent until the next `bash_output` poll.
  Schema.Struct({
    type: Schema.Literal("bg_output"),
    processId: Schema.String,
    stream: Schema.Literal("stdout", "stderr"),
    chunk: Schema.String,
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
  // A point where the run needs a human decision — the control-plane's
  // "decisions" channel. Two shapes share one event:
  //   `parked: true`  — an UNATTENDED (headless/scheduled) run hit something the
  //                      auto-approval judge wouldn't wave through; nobody is
  //                      watching, so it was DENIED and the need recorded here
  //                      for a human to review later.
  //   `parked: false` — an INTERACTIVE run opened a prompt for a human (emitted
  //                      alongside `approval_needed`), so a top-level "decisions"
  //                      list can surface it.
  Schema.Struct({
    type: Schema.Literal("needs_human"),
    sessionId: Schema.optional(Schema.String),
    nodeId: Schema.optional(Schema.String),
    tool: Schema.optional(Schema.String),
    summary: Schema.String,
    reason: Schema.String,
    folder: Schema.optional(Schema.String),
    parked: Schema.Boolean,
  }),
  // An inter-agent message hit the bus (blackboard post, a direct inbox message,
  // or a completion note) — the "messages flying" stream the control dashboard
  // tails. Rides the ledger so it replays like any event. `to` is the recipient
  // bus key when the message was ADDRESSED (an inbox post / a completion to a
  // parent) — the pump routes root-addressed notes onto the rail; a broadcast
  // (blackboard) has no `to`.
  Schema.Struct({
    type: Schema.Literal("board_note"),
    from: Schema.String,
    note: Schema.String,
    at: Schema.Number,
    to: Schema.optional(Schema.String),
  }),
)
export type AgentEvent = typeof AgentEvent.Type
