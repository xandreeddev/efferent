import { basename, resolve } from "node:path"
import { LanguageModel, Tool, Toolkit } from "@effect/ai"
import { Clock, Effect, FiberRef, Layer, Ref, Schema } from "effect"
import { ContextNodeId, type ContextUsage } from "../entities/AgentContext.js"
import type {
  AgentAfterToolCallEvent,
  AgentBeforeToolCallEvent,
  AgentHooks,
  AgentLlmRetryEvent,
  BeforeToolCallDecision,
} from "../entities/AgentHooks.js"
import { type AgentMessage, ConversationId } from "../entities/Conversation.js"
import type { Prompt } from "../entities/Prompt.js"
import type { Scope } from "../entities/Scope.js"
import { Approval, bashRuleKey } from "../ports/Approval.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Http } from "../ports/Http.js"
import { SettingsStore } from "../ports/SettingsStore.js"
import { Shell } from "../ports/Shell.js"
import { UtilityLlm } from "../ports/UtilityLlm.js"
import { Verifier } from "../ports/Verifier.js"
import { WebSearch } from "../ports/WebSearch.js"
import { agentSpanAttributes, subagentSpanName } from "../telemetry/spanNames.js"
import { runAgentLoop } from "./agentLoop.js"
import { generateHandoffBrief } from "./handoff.js"
import { handoffToMessage } from "./promptMapping.js"
import { RunContextRef, type RunContext } from "./runContext.js"
import {
  BUDGET_STOP_NOTE,
  budgetExhaustedFailure,
  DEFAULT_SUB_AGENT_TOKEN_BUDGET,
  drainPool,
  makeTokenPool,
  poolExhausted,
  type TokenPool,
} from "./tokenBudget.js"
import { Failure, toFailure } from "../entities/Failure.js"
import type { Memory } from "../entities/Memory.js"
import type { Skill } from "../entities/Skill.js"
import type { AgentDefinition } from "../entities/AgentDefinition.js"
import type { AgentModelRole } from "../entities/Model.js"
import type { AgentEvent } from "../entities/AgentEvent.js"
import { renderScopeSystemPrompt } from "../prompts/scopeAgent.js"
import {
  codingToolkit,
  makeCodingHandlers,
  type ScopeBinding,
} from "./codingToolkit.js"
import { type AgentBus, inboxToMessages, makeAgentBus } from "./agentBus.js"
import {
  addJob,
  loadJobs,
  parseCron,
  removeJob,
  type ScheduledJob,
} from "./schedule.js"
import { buildStalenessBrief, getWorkspaceRef } from "./staleness.js"
import { getScopePromptBody } from "./discoverScopeTree.js"
import { type ToolDefinition, shellEscape, substituteTemplate } from "./loadTools.js"

/**
 * A runnable scope: the `@effect/ai` Toolkit (base coding tools + the generic
 * `run_agent` tool) and its handler `Layer`. Provided to a `runAgentLoop` call
 * to make the root agent executable. Spawning a sub-agent is no longer a static
 * per-child `delegate_to_<name>` tool — it's the one `run_agent` tool the agent
 * configures at call time (folder + task), which persists a context-tree node
 * and runs a folder-scoped loop on demand.
 *
 * The dynamic toolkit can't be precisely typed, so we erase to
 * `Record<string, Tool.Any>`; `failureMode: "return"` makes results model-facing
 * data, so the erasure costs nothing at the call site.
 */
export interface ScopeRuntime {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>
  readonly handlerLayer: Layer.Layer<
    Tool.HandlersFor<Record<string, Tool.Any>>,
    never,
    // `ConversationStore | SettingsStore | UtilityLlm` (beyond the tool ports):
    // the handoff-brief seed (`generateHandoffBrief`) runs on the utility tier,
    // and the store/settings stay provided for the scheduled-run gate (the
    // root-tier `gateOnce` moving onto the `spawnAgent` cron path). The
    // per-coordinator gate that first widened this R is gone — gating is
    // root-only now (one tier).
    | FileSystem
    | Shell
    | Http
    | WebSearch
    | ContextTreeStore
    | ConversationStore
    | SettingsStore
    | UtilityLlm
    | Approval
    | Verifier
  >
  /**
   * **Human-driven resume**: continue an existing context-tree node in place —
   * the driver's counterpart of `run_agent({ seedFromNode, seedMode: "resume" })`.
   * Appends the task to the node's persisted context (prefixed with a staleness
   * brief when the workspace HEAD moved), re-runs the folder-scoped loop over
   * the full history, and records the return. Children it spawns hang off the
   * node; `budget` caps the turn's sub-agent spend (≤ 0 disables).
   */
  readonly resumeNode: (args: {
    readonly nodeId: ContextNodeId
    readonly task: string
    readonly budget?: number
    readonly maxSteps?: number
    /** Compaction budget (chars) per tool-result string for the resumed run. */
    readonly toolResultMaxChars?: number
  }) => Effect.Effect<
    { summary: string; filesChanged: ReadonlyArray<string>; nodeId: ContextNodeId },
    Failure,
    | FileSystem
    | Shell
    | Http
    | WebSearch
    | ContextTreeStore
    | Approval
    | LanguageModel.LanguageModel
  >
  /**
   * **Human-driven fresh spawn**: fire a new folder-scoped agent from a live
   * session — the driver's counterpart of the model's `run_agent` fresh spawn.
   * Creates a top-level context node under `rootConversationId` (so it shows in
   * `:tree`), runs it at depth 0 with its own fresh token pool, and records the
   * return. Pass `agent` to run a predefined role (else a generic coder).
   * `budget`/`maxSteps` default to the sub-agent constants when omitted.
   */
  readonly spawnAgent: (args: {
    readonly rootConversationId: ConversationId
    readonly folder: string
    readonly task: string
    readonly title?: string
    readonly agent?: string
    readonly budget?: number
    readonly maxSteps?: number
    readonly toolResultMaxChars?: number
    /** The overall goal this run serves — seeded onto the run's `RunContext` and
     *  inherited by every sub-agent (the mission backstop). The bare `spawnAgent`
     *  never set this, so a scheduled run + its fleet worked blind; the job router
     *  passes the job prompt here so the scheduled subtree knows the goal. */
    readonly mission?: string
    /** Whether a human is watching (default interactive). A scheduled job passes
     *  `"headless"` so this run's approval parks + denies instead of blocking on
     *  an absent human; inherited down the subtree. */
    readonly interactionPolicy?: "interactive" | "headless"
  }) => Effect.Effect<
    { summary: string; filesChanged: ReadonlyArray<string>; nodeId: ContextNodeId },
    Failure,
    | FileSystem
    | Shell
    | Http
    | WebSearch
    | ContextTreeStore
    | Approval
    | LanguageModel.LanguageModel
  >
  /** The in-memory comms bus (Phase 3): per-agent mailboxes + a shared
   *  blackboard. The driver posts to a RUNNING node's mailbox (human → agent);
   *  the loop drains it at each turn boundary. */
  readonly bus: AgentBus
}

/** Default step (turn) cap per spawned sub-agent — the unset default for
 *  `Settings.subAgentMaxSteps` (threaded through `RunContext`); also overridable
 *  via `BuildScopeRuntimeOptions.maxSteps`. Generous so a worker finishes real
 *  work on a codebase (read → edit → test → fix) without truncating mid-task. */
export const DEFAULT_SUB_AGENT_MAX_STEPS = 200

/** Default sub-agent nesting depth — the unset default for
 *  `Settings.subAgentMaxDepth`. 3 lets a hierarchy form (root → coordinator →
 *  sub-lead → worker) for larger jobs; raise it for deeper fleets. */
export const DEFAULT_SUB_AGENT_MAX_DEPTH = 3

/** Default per-sub-agent web-lookup budget — the unset default for
 *  `Settings.subAgentFetchBudget`. Max combined `web_fetch` + `search_web` calls
 *  ONE spawned agent makes before the tools refuse with a "report now" signal.
 *  15 is generous for a single research angle (a few searches + a few reads) yet
 *  hard-stops the looping-researcher pathology behind the 69-fetch runaway. The
 *  root coder is exempt (its binding leaves `fetchBudget` unset). */
export const DEFAULT_SUB_AGENT_FETCH_BUDGET = 15

/** Appended to a sub-agent's summary when the step cap cut it off mid-work —
 *  without it the run's mid-thought last sentence reads as the deliverable. */
export const STEP_STOP_NOTE =
  "[stopped early: the step limit was reached — this result is partial]"

/** Recorded as a sub-agent's return summary when its fiber is interrupted
 *  (Esc / `:stop` / teardown) or dies before reaching a terminal path — set by
 *  the exit finalizer so the DB node never stays `running` and the parent is
 *  notified immediately instead of waiting on the mid-session sweeper. */
export const INTERRUPTED_NOTE = "[interrupted — run did not finish]"

/** Recorded as a sub-agent's return summary when the stall watchdog trips —
 *  the run made no progress (no turn, no tool result, no retry) for
 *  {@link SUBAGENT_STALL_DEADLINE_MS}, so it was interrupted. This is the fix for
 *  the silent class of failure that BOTH existing backstops miss: the exit
 *  finalizer only fires when the fiber EXITS (a parked fiber hasn't), and the
 *  mid-session sweeper only flips a node whose fiber is no longer on the bus (a
 *  parked-but-alive fiber still is). A sub-agent whose first model call hung thus
 *  sat `running` with zero turns for up to ~20 min while its parent's
 *  `wait_for_agents` looped blind — "stuck checking for agents, none ever ran". */
export const STALL_NOTE =
  "[stalled — the run made no progress within the watchdog deadline and was stopped]"

/** No-progress deadline for a SPAWNED sub-agent: if no turn starts, no tool
 *  result lands, and no LLM retry fires for this long, the run is interrupted
 *  (so the parent unblocks). Generous on purpose — it must exceed the longest
 *  single legitimate blocking op, one LLM request (capped at the adapter request
 *  timeout, 2 min). A live, working sub-agent emits a turn-start before every
 *  model call, so it never approaches this; only a genuine freeze does. A run
 *  that already produced assistant text is finalized WITH that text preserved
 *  (see the exit finalizer) — the watchdog must never discard finished work. */
export const SUBAGENT_STALL_DEADLINE_MS = 180_000

/** How often the stall watchdog wakes to compare now − last-progress against the
 *  deadline. Small relative to the deadline so the kill lands promptly once the
 *  run is declared stalled, cheap enough to be free when the run is healthy. */
export const WATCHDOG_TICK_MS = 15_000

export interface BuildScopeRuntimeOptions {
  readonly skills: ReadonlyArray<Skill>
  /**
   * Durable project-knowledge records (`.efferent/memory/*.md`) — the index is
   * injected into the prompt, bodies are lazy-loaded via `read_memory`, and new
   * records are written via `remember`. Required like `skills`/`agents` — pass
   * `[]` when there are none. Shared across the root and every sub-agent.
   */
  readonly memory: ReadonlyArray<Memory>
  /**
   * Predefined agent ROLES (`.efferent/agents/*.md`) selectable by name via
   * `run_agent({ agent })` and the TUI `:spawn`. Required like `skills` —
   * pass `[]` when there are none (the sane default). Snapshotted at build
   * time; an agent imported mid-session applies on the next launch.
   */
  readonly agents: ReadonlyArray<AgentDefinition>
  /**
   * Declarative tools (`.efferent/tools/*.md`) callable via `run_tool`. Required
   * like `skills`/`agents` — pass `[]` when there are none.
   */
  readonly tools: ReadonlyArray<ToolDefinition>
  /**
   * The workspace's instruction files (`AGENT.md`, `.efferent/CONSTRAINTS.md`, …)
   * PRE-RENDERED into a prompt block by the driver (the CLI's
   * `renderInstructionsSection`). Threaded into EVERY spawned sub-agent's prompt
   * so the fleet inherits the project's own conventions — its build/verify
   * command, its hard rules — instead of guessing. Absent ⇒ nothing injected.
   */
  readonly instructions?: string
  /** Step budget for each (nested) sub-agent loop. Default 80. */
  readonly maxSteps?: number
  /** Max spawn nesting depth; beyond it `run_agent` returns a failure. Default 2. */
  readonly maxDepth?: number
  /** Allow the `bash` tool. Default true. */
  readonly allowBash?: boolean
  /** No-progress deadline (ms) for a spawned sub-agent's stall watchdog. Default
   *  {@link SUBAGENT_STALL_DEADLINE_MS}. An internal seam — tests inject a tiny
   *  value to exercise the watchdog without a real wait; production never sets it. */
  readonly stallDeadlineMs?: number
  /** Optional sink for inter-agent messages — the daemon passes its ledger
   *  `publish` so blackboard/inbox/completion notes ride the event stream as
   *  `board_note` events (the "messages flying" firehose). */
  readonly onBusEvent?: (event: AgentEvent) => Effect.Effect<void>
}

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}…`

/** Parse a `run_tool` args JSON-object string into string-valued params. `{}` for
 *  empty/absent; undefined when it isn't a JSON object (a validation failure).
 *  `JSON.parse` can throw, which core bans catching with try/catch — `Effect.try`
 *  funnels the throw into a typed failure that `orElseSucceed(undefined)` maps to
 *  the same "validation failure" result the catch produced. */
const parseToolArgs = (
  raw: string | undefined,
): Effect.Effect<Record<string, string> | undefined> => {
  if (raw === undefined || raw.trim().length === 0) return Effect.succeed({})
  return Effect.try(() => JSON.parse(raw) as unknown).pipe(
    Effect.map((v) => {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined
      const out: Record<string, string> = {}
      for (const [k, val] of Object.entries(v)) {
        out[k] = typeof val === "string" ? val : String(val)
      }
      return out
    }),
    Effect.orElseSucceed(() => undefined),
  )
}

/** Base coding tool definitions (read/write/edit/bash/grep/glob/ls/read_skill/web_fetch). */
const baseToolDefs = Object.values(codingToolkit.tools) as ReadonlyArray<Tool.Any>

/**
 * The one generic delegation tool. Static (no per-scope wiring): the agent
 * picks the folder + task at call time, and optionally resumes/branches an
 * existing context node by id. Folder sandboxing is applied per call via a
 * `ScopeBinding`; the folder's `SCOPE.md` body is injected as ambient context.
 */
const RunAgentTool = Tool.make("run_agent", {
  description:
    "Spawn a sub-agent to do focused work scoped to a folder. It reads anywhere but " +
    "writes/runs bash only inside that folder, runs in its own persisted context, and " +
    "works in the BACKGROUND: this call returns { nodeId, name, status: \"running\" } " +
    "IMMEDIATELY — it does NOT wait for the agent to finish, so you never block and can " +
    "spawn several at once (they run in parallel). To get a spawned agent's result, call " +
    "wait_for_agents (or you'll receive its completion in your inbox at a turn boundary). " +
    "You can send_message it while it runs. Prefer it when a change is localized to one " +
    "area; it keeps your own context focused. Be explicit in 'task' — the sub-agent starts " +
    "fresh unless you resume/branch a node. DEFAULT TO A FRESH SPAWN: one agent = one piece " +
    "of work; a new task gets a new agent even in the same folder (fresh context is cheaper " +
    "and more focused — a resume re-feeds the node's entire history every turn). Reuse a node " +
    "only when the new task is a direct follow-up on that node's OWN work: seedMode 'resume' " +
    "to continue/fix/extend what it just did (its accumulated file knowledge pays for itself), " +
    "'branch' to retry or take an alternative direction from its context without growing it. " +
    "Two ways to shape the sub-agent: name a predefined ROLE with 'agent', OR define one INLINE " +
    "with 'instructions' (its persona) + optional 'tools'. Use a role when one fits, inline when " +
    "none does, or both to add focus on top of a role. You shape its prompt, tools, and model TIER " +
    "via 'role' ('code' to write code, 'general' for research/analysis/orchestration) — but never a " +
    "specific model; the human owns which model backs each tier.",
  parameters: {
    name: Schema.String.annotations({
      description:
        "Short display name for THIS agent (2-5 words, task-specific — e.g. 'audit state layer', " +
        "'fix scroll bug'). Shown wherever the agent appears in the UI; never reuse a name across " +
        "parallel agents.",
    }),
    folder: Schema.String.annotations({
      description:
        "Folder to scope the sub-agent to, relative to the workspace root (e.g. 'packages/adapters').",
    }),
    task: Schema.String.annotations({
      description:
        "The sub-agent's full brief. It sees ONLY this text, its folder, that folder's SCOPE.md, and " +
        "the project knowledge — NOT your conversation, the user's request, your plan, or what other " +
        "agents found. You are its only bridge to all of that, so write a COMPLETE brief, not a " +
        "one-liner: (1) OBJECTIVE — what to do, concretely; (2) CONTEXT — the relevant background, " +
        "constraints, and any prior findings/decisions it needs (paste them, don't reference them); " +
        "(3) OUTPUT — what to produce or report back; (4) BOUNDARIES — what's out of scope. A vague " +
        "task ('research X', 'fix the bug') produces vague, duplicated, or wrong work.",
    }),
    seedFromNode: Schema.optional(Schema.String).annotations({
      description:
        "An existing context-node id (from a prior run_agent result) — ONLY when the task is a " +
        "direct follow-up on that node's own work (continue/fix/extend it). An unrelated task, " +
        "even in the same folder, gets a fresh spawn instead.",
    }),
    seedMode: Schema.optional(Schema.Literal("resume", "branch", "handoff")).annotations({
      description:
        "With seedFromNode: 'handoff' (PREFER for follow-ups) seeds a fresh node with a generated " +
        "brief of the source's work — continuity at a fraction of the tokens; 'resume' continues " +
        "the node verbatim (full history every turn — only when exact file contents in its context " +
        "matter); 'branch' copies the full history into a new node. Defaults to 'branch'.",
    }),
    agent: Schema.optional(Schema.String).annotations({
      description:
        "Optional name of a predefined agent ROLE (from .efferent/agents/<name>.md) to run this task " +
        "as — it sets the sub-agent's system-prompt instructions and its tool allowlist. Omit for a " +
        "generic folder-scoped coder. Use a role when the task fits a specialty (e.g. 'reviewer', " +
        "'security-auditor', 'docs-writer').",
    }),
    instructions: Schema.optional(Schema.String).annotations({
      description:
        "Define a one-off sub-agent INLINE: the persona + instructions for THIS spawn — they become " +
        "its system-prompt body (wrapped by the usual scope / write-confinement / return-contract " +
        "scaffold). Use it to craft a task-tailored specialist when no predefined 'agent' role fits; " +
        "combine with 'agent' to ADD focus on top of a role's instructions. Omit for a generic coder.",
    }),
    tools: Schema.optional(Schema.Array(Schema.String)).annotations({
      description:
        "Optional tool allowlist for an inline agent, e.g. ['read_file','grep','glob','ls'] for a " +
        "read-only reviewer. Omit to grant the full base coding toolkit. Can only SUBSET the available " +
        "tools — never grants anything that doesn't exist; include 'run_agent' only to let the inline " +
        "agent spawn its own helpers (bounded by the depth limit). Unknown names are ignored.",
    }),
    role: Schema.optional(Schema.Literal("general", "code")).annotations({
      description:
        "Which model TIER this sub-agent runs on: 'code' for WRITING CODE (the dedicated coding " +
        "model), 'general' for research, analysis, planning, or orchestration (the general-purpose " +
        "model). NOT a specific model — the human configures which model backs each tier. Omit to " +
        "inherit the named role's tier, else defaults to 'general'. Pick 'code' only when the " +
        "sub-agent will edit/write files.",
    }),
  },
  success: Schema.Struct({
    // The spawned node's id — a real `ContextNodeId`, so the tool's output
    // schema encodes/validates it as a branded UUID (the model later feeds it
    // back as `seedFromNode` / `wait_for_agents` / `send_message`, decoded at
    // those boundaries).
    nodeId: ContextNodeId,
    /** The agent's display name (echoed back so you can refer to it). */
    name: Schema.String,
    /** Always "running" — the work happens in the background; gather its result
     *  with wait_for_agents. */
    status: Schema.Literal("running"),
  }),
  failure: Failure,
  failureMode: "return",
})

/**
 * The ROOT's delegation tool — a **hard-railed `run_agent`**. Same tool name and
 * handler as {@link RunAgentTool}, but the schema only lets the root express a
 * spawn to a fleet LEAD (coordinator / research-coordinator) with a brief — no
 * `role`, no inline `instructions`/`tools`, no bare-worker spawn, no resume. The
 * lead owns staffing, sequencing, the gate, and the retry loop. A prompt rule
 * alone didn't hold (the root still spawned direct `role:code` workers, live-
 * verified), so this is the mechanical guarantee at the SCHEMA level: the root
 * literally cannot express anything but "delegate to a coordinator".
 */
const RootDelegateTool = Tool.make("run_agent", {
  description:
    "Delegate this objective to a fleet LEAD — the only way you, the orchestrator, get work done. " +
    'Returns { nodeId, name, status: "running" } IMMEDIATELY (non-blocking); gather the result with ' +
    "wait_for_agents or from your inbox at a turn boundary, then relay/aggregate it. The lead plans, " +
    "staffs and SEQUENCES the specialists (one writer at a time), validates with the architect, and " +
    "GATES the deliverable before returning — you never spawn, sequence, or gate workers yourself, and " +
    "you never read or edit files yourself. Write a COMPLETE brief in 'task'.",
  parameters: {
    name: Schema.String.annotations({
      description: "Short display name for this delegation (2-5 words, task-specific).",
    }),
    folder: Schema.String.annotations({
      description: "Folder to scope the work to, relative to the workspace root (e.g. 'packages/cli').",
    }),
    task: Schema.String.annotations({
      description:
        "The full brief for the lead — it starts fresh and sees ONLY this text (not your conversation or " +
        "the user's request). Include: OBJECTIVE (what to achieve, concretely), CONTEXT (background, " +
        "constraints, prior decisions/findings — paste them, don't reference them), OUTPUT (what to deliver " +
        "or report), and BOUNDARIES (what's out of scope).",
    }),
    agent: Schema.Literal("coordinator", "research-coordinator").annotations({
      description:
        "Which lead to route to — the ONLY delegation choice: 'coordinator' for ANY code work (it staffs + " +
        "sequences coders, validates with the architect, and gates the result); 'research-coordinator' for " +
        "investigation (it fans out parallel read-only researchers and synthesizes one sourced answer).",
    }),
  },
  success: Schema.Struct({
    nodeId: ContextNodeId,
    name: Schema.String,
    status: Schema.Literal("running"),
  }),
  failure: Failure,
  failureMode: "return",
})

/**
 * The non-blocking **gather** tool. A coordinator spawns its fleet (each
 * `run_agent` returns immediately) and then calls this to wait for results
 * WITHOUT freezing: it blocks only the caller's own fiber, interruptibly, and
 * returns the moment any watched agent finishes, a message lands in the caller's
 * inbox (a human or sibling reaching it), or the timeout elapses. The result is
 * a full snapshot — every watched agent's status (and the summary/files of
 * finished ones) plus the caller's freshly-drained inbox and the blackboard tail
 * — so the caller can react incrementally (validate a finished piece, answer a
 * question, re-plan) and call it again. No agent ever blocks another.
 */
const WaitForAgentsTool = Tool.make("wait_for_agents", {
  description:
    "Wait (without blocking anyone else) for sub-agents you spawned to make progress, then read " +
    "their status. Returns as soon as any watched agent finishes, someone messages you, or the " +
    "timeout passes — whichever first. Use it after spawning a fleet with run_agent to collect " +
    "results: it gives each agent's status (running/ok/error) with the summary + files of finished " +
    "ones, plus any messages sent to you and recent blackboard notes. A return with allDone:false and " +
    "agents still running is NORMAL — just call it again; it is NOT a signal that they are stuck or " +
    "that you should spawn more. Loop it until allDone. Omit 'nodeIds' to watch every agent you spawned.",
  parameters: {
    nodeIds: Schema.optional(Schema.Array(Schema.String)).annotations({
      description:
        "The run_agent nodeIds to watch. Omit to watch all agents you spawned this session.",
    }),
    timeoutSeconds: Schema.optional(Schema.Number).annotations({
      description: "Max seconds to wait before returning a status snapshot anyway (default 10, max 300). It returns earlier the moment a watched agent finishes or a message lands, so this is just the idle ceiling.",
    }),
  },
  success: Schema.Struct({
    agents: Schema.Array(
      Schema.Struct({
        nodeId: Schema.String,
        name: Schema.String,
        status: Schema.Literal("running", "ok", "error"),
        summary: Schema.optional(Schema.String),
        filesChanged: Schema.optional(Schema.Array(Schema.String)),
      }),
    ),
    /** Messages sent to you since your last turn (from the human or siblings). */
    messages: Schema.Array(Schema.Struct({ from: Schema.String, content: Schema.String })),
    /** Recent blackboard notes. */
    notes: Schema.Array(Schema.Struct({ from: Schema.String, note: Schema.String })),
    /** True when the wait ended on the timeout (agents may still be running). */
    timedOut: Schema.Boolean,
    /** True when every watched agent has finished. */
    allDone: Schema.Boolean,
  }),
  failure: Failure,
  failureMode: "return",
})

/**
 * The comms tools (Phase 3): message a sibling agent's inbox, and post/read a
 * shared blackboard. Handler-backed by the in-memory {@link AgentBus}; the
 * recipient drains its inbox at its next turn boundary.
 */
const SendMessageTool = Tool.make("send_message", {
  description:
    "Send a message to another RUNNING agent by its context-node id (a nodeId from a run_agent result). " +
    "The recipient reads it at its next turn. Use it to coordinate with sibling agents you spawned or were " +
    "told about. Fails if that agent isn't currently running (a finished agent's result is in its return summary).",
  parameters: {
    to: Schema.String.annotations({
      description: "The recipient agent's context-node id (the nodeId a run_agent call returned).",
    }),
    content: Schema.String.annotations({ description: "The message to deliver." }),
  },
  success: Schema.Struct({ delivered: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

const BlackboardPostTool = Tool.make("blackboard_post", {
  description:
    "Post a short note to the shared blackboard every agent in this turn's fleet can read — a finding, a " +
    "decision, a warning. Use it so parallel siblings don't duplicate work or clobber each other.",
  parameters: {
    note: Schema.String.annotations({ description: "The note to share (keep it short)." }),
  },
  success: Schema.Struct({ posted: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

const BlackboardReadTool = Tool.make("blackboard_read", {
  description:
    "Read the shared blackboard — notes other agents in this fleet have posted. Check it before starting and " +
    "while working to stay coordinated.",
  parameters: {
    limit: Schema.optional(Schema.Number).annotations({
      description: "Max recent notes to return; omit for all.",
    }),
  },
  success: Schema.Struct({
    notes: Schema.Array(Schema.Struct({ from: Schema.String, note: Schema.String })),
  }),
  failure: Failure,
  failureMode: "return",
})

/**
 * The single dispatcher for declarative tools (Phase 2). The tools themselves
 * are defined in `.efferent/tools/*.md` and listed in the prompt; the model
 * names one + passes its params as a JSON-object string (uniform across
 * providers — no per-tool dynamic schema).
 */
const RunToolTool = Tool.make("run_tool", {
  description:
    "Run a custom tool defined in .efferent/tools (see the '# Custom tools' section for names + params). " +
    "Pass the tool's name and its params as a JSON-object string in 'args' with string values, e.g. " +
    'args: \'{"glob":"src/**/*.ts"}\'. Omit args for a tool that takes none.',
  parameters: {
    name: Schema.String.annotations({ description: "The custom tool's name (from # Custom tools)." }),
    args: Schema.optional(Schema.String).annotations({
      description: 'JSON object of the tool\'s params as string values, e.g. {"path":"src"}.',
    }),
  },
  success: Schema.Struct({
    output: Schema.String,
    exitCode: Schema.optional(Schema.Number),
  }),
  failure: Failure,
  failureMode: "return",
})

/**
 * Schedule a future/recurring run — cron as a TOOL, so the orchestrator can
 * defer its own work or set up recurring checks, not just the human via
 * `:schedule`. The job fires as a fresh agent run in this workspace while
 * efferent (or its daemon) is open.
 *
 * Deferred follow-ups (larger changes, NOT done here): a fired-job → session
 * notification (surface a scheduled run's start/finish in the originating
 * session), and a run-outcome ledger (persist each fire's result so the
 * assistant can review history beyond `lastRunMs`).
 */
const ScheduleTool = Tool.make("schedule", {
  description:
    "Schedule a task to run later or on a recurring schedule (5-field cron: 'min hour dom month dow'). " +
    "The job fires as a fresh agent run in THIS workspace whenever it's due, while efferent or its daemon " +
    "is open — use it to defer follow-up work or set up recurring checks (e.g. a daily review). " +
    "Returns the job id. The human manages jobs with :schedule.",
  parameters: {
    cron: Schema.String.annotations({
      description:
        "5-field cron, e.g. '0 9 * * 1' (Mondays 9am) or '*/30 * * * *' (every 30 minutes).",
    }),
    task: Schema.String.annotations({ description: "What the scheduled run should do." }),
    folder: Schema.optional(Schema.String).annotations({
      description: "Folder to scope the run to, relative to the workspace root (default the root).",
    }),
    agent: Schema.optional(Schema.String).annotations({
      description: "Optional agent role to run the job as (e.g. 'reviewer').",
    }),
  },
  success: Schema.Struct({ id: Schema.String, cron: Schema.String }),
  failure: Failure,
  failureMode: "return",
})

/** One scheduled-job row in `list_scheduled_jobs` (mirrors the `:schedule` list). */
const ScheduledJobView = Schema.Struct({
  id: Schema.String,
  cron: Schema.String,
  task: Schema.String,
  folder: Schema.String,
  agent: Schema.optional(Schema.String),
  lastRunMs: Schema.optional(Schema.Number),
})

/**
 * List the scheduled jobs for THIS workspace — the same cron list `:schedule`
 * shows and `schedule` writes to. Lets the assistant review what it (or the
 * human) has queued before adding or cancelling a job.
 */
const ListScheduledJobsTool = Tool.make("list_scheduled_jobs", {
  description:
    "List the scheduled (cron) jobs for this workspace — id, cron expression, task, folder, and last run time. " +
    "Use it to review what's queued before scheduling more work or cancelling a job. " +
    "Optionally narrow to a folder (relative to the workspace root).",
  parameters: {
    folder: Schema.optional(Schema.String).annotations({
      description: "Only return jobs scoped to this folder (relative to the workspace root).",
    }),
  },
  success: Schema.Struct({ jobs: Schema.Array(ScheduledJobView) }),
  failure: Failure,
  failureMode: "return",
})

/**
 * Cancel a scheduled job by its id (from `list_scheduled_jobs` or the id a
 * `schedule` call returned). Removes it from the cron list so it never fires
 * again; `found: false` if no job with that id exists.
 */
const CancelScheduledJobTool = Tool.make("cancel_scheduled_job", {
  description:
    "Cancel a scheduled (cron) job by its id — the id from list_scheduled_jobs or the one a schedule call returned. " +
    "Removes it from the workspace's cron list so it won't fire again.",
  parameters: {
    id: Schema.String.annotations({ description: "The job id to cancel." }),
  },
  success: Schema.Struct({ id: Schema.String, found: Schema.Boolean }),
  failure: Failure,
  failureMode: "return",
})

// The self-improving loop is STRUCTURAL, not a set of tools the model drives:
// the mandatory Opus gate runs ONCE, at the root (`driveLoop`), and the distiller
// runs at the turn boundary — with no `verify_with_gate` / `note_constraint` tool
// to remember. (The old per-coordinator gate tier is gone: it ran a 30-min Opus
// subprocess inside the sub-agent watchdog's 180s window, which killed finished
// leads as "stalled" — one gate tier, at the root, judges the aggregate.) The
// architect role stays as the in-fleet, fine-grained per-piece review.

/** `[name, def]` entries for the comms + run_tool + schedule tools — for the toolkit + role allowlists. */
const commsToolEntries: ReadonlyArray<readonly [string, Tool.Any]> = [
  ["send_message", SendMessageTool],
  ["blackboard_post", BlackboardPostTool],
  ["blackboard_read", BlackboardReadTool],
  ["wait_for_agents", WaitForAgentsTool],
  ["run_tool", RunToolTool],
  ["schedule", ScheduleTool],
  ["list_scheduled_jobs", ListScheduledJobsTool],
  ["cancel_scheduled_job", CancelScheduledJobTool],
]

/** The toolkit is static: base coding tools + comms/run_tool + the `run_agent`
 *  + `wait_for_agents` tools. (Declarative tools are dispatched through the
 *  single `run_tool`, so the toolkit shape doesn't vary with which tool files
 *  are present.) */
const genericToolkit = Toolkit.make(
  ...([
    ...baseToolDefs,
    ...commsToolEntries.map(([, d]) => d),
    RunAgentTool,
  ] as ReadonlyArray<Tool.Any>),
) as unknown as Toolkit.Toolkit<Record<string, Tool.Any>>

/**
 * The **orchestration-only** toolkit — what the ROOT gets when a fleet is in the
 * roster (always-orchestrate mode). It carries ONLY the four tools an interactive
 * orchestrator needs — delegate, gather, steer, plan — and **deliberately NO work
 * tools** (no read/edit/write/grep/glob/ls/Bash/search/fetch/sessions) and **no
 * gate tools** (gating is structural — `driveLoop` runs the Opus gate after the
 * root's run, so the root never drives it). A prompt rule alone didn't stop the
 * root from reading and editing itself (live-verified), so this is the mechanical
 * guarantee: if the root *can't* call a work tool, it *must* route the work to a
 * lead. Handlers still exist in the full layer — this only narrows what the model
 * is offered, so the subset's handler layer agrees.
 *
 * Deliberately trimmed (2026-06-30): the scheduling tools (`schedule`/
 * `list_scheduled_jobs`/`cancel_scheduled_job`) and the blackboard tools
 * (`blackboard_post`/`blackboard_read`) were REMOVED from the root — a weak model
 * fixated on them (`list_scheduled_jobs`/`blackboard_read` in a loop) instead of
 * delegating. Scheduling is a daemon/cron concern; the blackboard is for sibling
 * coordination (the root briefs each lead via the `run_agent` task). Both remain
 * available to sub-agents/leaves; only the root stops being handed them.
 */
const ORCHESTRATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "run_agent",
  "wait_for_agents",
  "send_message",
  "update_plan",
])

const orchestrationToolkit = Toolkit.make(
  ...((Object.entries(genericToolkit.tools) as Array<[string, Tool.Any]>)
    // Drop the full `run_agent` — the root gets the hard-railed RootDelegateTool
    // (same name) instead, so it can only delegate to a lead.
    .filter(([name]) => ORCHESTRATION_TOOL_NAMES.has(name) && name !== "run_agent")
    .map(([, d]) => d) as ReadonlyArray<Tool.Any>),
  RootDelegateTool,
) as unknown as Toolkit.Toolkit<Record<string, Tool.Any>>

/** The fleet LEADS the root may delegate to. The root (depth 0, orchestrate mode)
 *  must route through one of these — never a bare-role worker — so the lead owns
 *  staffing, sequencing, and the gate. */
const LEAD_AGENT_NAMES: ReadonlyArray<string> = ["coordinator", "research-coordinator"]

/**
 * Is the ROOT a pure orchestrator for this roster? True iff a fleet lead
 * (`coordinator`/`research-coordinator`) is present — then the root gets the
 * orchestration-only toolkit (no work tools) and must delegate. The SINGLE source
 * of truth for this decision: both the toolkit gate (here) and the root system
 * prompt (`coderSystemPrompt` in the CLI) call this, so the prompt and the toolkit
 * can never disagree about whether the root can do work.
 */
export const isOrchestrateMode = (agents: ReadonlyArray<{ readonly name: string }>): boolean =>
  agents.some((a) => LEAD_AGENT_NAMES.includes(a.name))

/** The research lead — its whole subtree stays read-only (see RunContext.researchSubtree). */
const RESEARCH_COORDINATOR_NAME = "research-coordinator"
/** The code lead — a research subtree refuses to spawn one (implementation is the root's call). */
const CODE_COORDINATOR_NAME = "coordinator"

/** Tools that can MUTATE the workspace (write a file or run a shell that can).
 *  Stripped from any spawn inside a read-only research subtree. */
const MUTATING_TOOL_NAMES: ReadonlyArray<string> = [
  "write_file",
  "edit_file",
  "Bash",
  "bash_output",
  "kill_bash",
  "session_start",
  "session_send",
  "session_read",
  "session_kill",
  "session_list",
]

/** A bare (no-role, no-inline-tools) spawn inside a research subtree resolves to
 *  THIS read-only worker instead of the full coding toolkit — the leak that let a
 *  research-coordinator mint a full-toolkit coder. Web + read + comms only. */
const READ_ONLY_RESEARCH_WORKER: AgentDefinition = {
  name: "research-worker",
  description: "Read-only research worker (investigation only — never writes files)",
  role: "general",
  body: "You investigate read-only: search the web and read the workspace, then report findings with sources. You NEVER write or edit files and you never run shell commands — if the task implies a change, describe the change as a recommendation in your findings.",
  tools: [
    "read_file",
    "grep",
    "glob",
    "ls",
    "read_skill",
    "search_web",
    "web_fetch",
    "update_plan",
    "send_message",
    "blackboard_post",
    "blackboard_read",
  ],
  sourcePath: "<builtin>",
}

/** Constrain a resolved definition to read-only for a research subtree: a bare
 *  spawn becomes the read-only worker; any explicit toolset loses its mutating
 *  tools; the tier drops to `general`. Exported for unit tests. */
export const constrainToReadOnly = (def: AgentDefinition | undefined): AgentDefinition => {
  if (def === undefined) return READ_ONLY_RESEARCH_WORKER
  return {
    ...def,
    role: "general",
    tools: (def.tools ?? READ_ONLY_RESEARCH_WORKER.tools ?? []).filter(
      (t) => !MUTATING_TOOL_NAMES.includes(t),
    ),
  }
}

/**
 * Resolve a role's tool allowlist to `[name, def]` entries. A definition WITH
 * a `tools` list is filtered against the available tools (base coding tools +
 * `run_agent`) — so `run_agent` is offered only when the list names it. A
 * definition WITHOUT a list gets all base coding tools but NOT `run_agent`
 * (roles are leaf workers by default). Unknown names in the list are silently
 * dropped. The names returned are exactly the keys to project the handler
 * record onto, so the subset toolkit and its handlers always agree.
 */
export const roleToolEntries = (
  def: AgentDefinition,
): ReadonlyArray<readonly [string, Tool.Any]> => {
  const base = Object.entries(codingToolkit.tools) as Array<[string, Tool.Any]>
  if (def.tools === undefined) return base
  const allow = new Set(def.tools)
  const all: ReadonlyArray<readonly [string, Tool.Any]> = [
    ...base,
    ...commsToolEntries,
    ["run_agent", RunAgentTool] as const,
  ]
  return all.filter(([name]) => allow.has(name))
}

/**
 * Resolve a requested role name against the loaded definitions. Absent/blank ⇒
 * no role (generic spawn). A named-but-unknown agent fails with a model-facing
 * `UnknownAgent` (it lists what's available) rather than silently degrading —
 * an unhonoured role request is a real mistake to surface.
 */
const resolveAgent = (
  agents: ReadonlyArray<AgentDefinition>,
  name: string | undefined,
): Effect.Effect<AgentDefinition | undefined, { error: string; message: string }> => {
  if (name === undefined || name.trim().length === 0) return Effect.succeed(undefined)
  const wanted = name.trim()
  const found = agents.find((a) => a.name === wanted)
  if (found !== undefined) return Effect.succeed(found)
  const available = agents.map((a) => a.name).join(", ")
  return Effect.fail({
    error: "UnknownAgent",
    message: `No agent named '${wanted}'.${
      available.length > 0 ? ` Available: ${available}.` : " No agent roles are defined."
    }`,
  })
}

/**
 * A short, stable note reminding a freshly-spawned sub-agent of the human's
 * overall **mission** — the structural backstop against context loss on spawn.
 * The spawner's `task` is the detail; this is the goal that task serves, so a
 * leaf agent never works blind even when the brief is terse. Empty when no
 * mission is in context; a stable single message ⇒ it doesn't churn the cache.
 */
export const missionPreamble = (mission: string | undefined): ReadonlyArray<AgentMessage> =>
  mission !== undefined && mission.trim().length > 0
    ? [
        {
          role: "user",
          content:
            "[Overall mission — the human's request this whole effort serves. Your task " +
            "below is ONE part of it; use this only as context for how your piece fits, " +
            "then do exactly the task you were given.]\n" +
            mission.trim(),
        },
      ]
    : []

/**
 * Layer per-call INLINE overrides onto the resolved role (if any) — the
 * dynamic-agent path. When `instructions`/`tools`/`role` are all absent this
 * returns `base` unchanged (the named-role and generic-coder paths are
 * untouched). Otherwise it produces an ad-hoc `AgentDefinition` fed into the
 * SAME `definition` slot a predefined role uses, so `renderScopeSystemPrompt`'s
 * body, {@link roleToolEntries}' allowlist, and the model `role` all reuse the
 * existing flow verbatim. A specific MODEL is deliberately NOT configurable —
 * only the role TIER (general | code), which maps to a model the human configured.
 *
 * Rule: the inline `instructions` are APPENDED to the role body (role leads,
 * refinement follows — mirrors how `scopeBody` is appended); `tools`/`role` are
 * atomic, so the call's explicit value OVERRIDES the base's (else inherits it).
 * Tool names are trimmed + deduped here; validity is enforced later by
 * `roleToolEntries` (subset-only — unknown names dropped). The display title
 * comes from the `name` param, not `definition.name`, so `"inline"` never shows.
 */
export const applyInlineDefinition = (
  base: AgentDefinition | undefined,
  inline: {
    readonly instructions?: string | undefined
    readonly tools?: ReadonlyArray<string> | undefined
    readonly role?: AgentModelRole | undefined
  },
): AgentDefinition | undefined => {
  const instr = inline.instructions?.trim()
  const hasInstr = instr !== undefined && instr.length > 0
  const cleanTools = inline.tools?.map((t) => t.trim()).filter((t) => t.length > 0)
  const hasTools = cleanTools !== undefined && cleanTools.length > 0
  const role = inline.role ?? base?.role
  if (!hasInstr && !hasTools && role === undefined) return base

  const body = [base?.body, hasInstr ? instr : undefined]
    .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
    .join("\n\n")

  return {
    name: base?.name ?? "inline",
    description: base?.description ?? "Inline task-tailored agent",
    body,
    ...(role !== undefined ? { role } : {}),
    ...(hasTools
      ? { tools: [...new Set(cleanTools)] }
      : base?.tools !== undefined
        ? { tools: base.tools }
        : {}),
    sourcePath: base?.sourcePath ?? "<inline>",
  }
}

/**
 * Inner hooks for a spawned sub-agent's loop. Forwards the parent's tool-call +
 * sub-agent + skill events (so the TUI shows nested activity), chains a
 * file-tracker onto `onAfterToolCall` (write/edit successes feed the node's
 * `filesChanged`), accumulates token usage, and — deliberately — does NOT
 * forward `onTurnStart`/`onAssistantMessage`/`onAgentEnd` (those belong to the
 * outer loop; forwarding `onAgentEnd` would end the turn early).
 *
 * Budget wiring: each LLM call's billed tokens drain the shared `pool`, and
 * `onShouldStopAfterTurn` halts the loop at the next turn *boundary* once the
 * pool is spent (never mid-tool-call — the message buffer stays pairing-valid),
 * flagging `budgetStopRef` so the caller can mark the result partial.
 */
const makeInnerHooks = <R>(
  parent: AgentHooks<R> | undefined,
  nodeId: ContextNodeId,
  role: AgentModelRole,
  filesRef: Ref.Ref<ReadonlyArray<string>>,
  usageRef: Ref.Ref<ContextUsage>,
  pool: TokenPool,
  budgetStopRef: Ref.Ref<boolean>,
  bus: AgentBus,
  /** Stall-watchdog liveness: stamp "now" on every observable step (turn start,
   *  tool result, narration) so a parked run — and only a parked run — crosses
   *  the no-progress deadline. */
  bumpProgress: Effect.Effect<void>,
  /** THIS run's latest assistant text (never a nested child's — those arrive
   *  with `subAgentNodeId` already stamped). The exit finalizer reads it so an
   *  interrupted/stalled run keeps its produced work instead of discarding it. */
  lastTextRef: Ref.Ref<string>,
): AgentHooks<R> => {
  const trackFiles = (event: AgentAfterToolCallEvent) =>
    Effect.gen(function* () {
      if (!event.ok) return
      if (event.toolName !== "write_file" && event.toolName !== "edit_file") return
      const path = (event.result as { path?: unknown })?.path
      if (typeof path !== "string") return
      yield* Ref.update(filesRef, (arr) => (arr.includes(path) ? arr : [...arr, path]))
    })

  const parentBefore = parent?.onBeforeToolCall
  const parentAfter = parent?.onAfterToolCall
  const parentAssistant = parent?.onAssistantMessage
  // Every forwarded event is stamped with this node's id — under parallel
  // fan-out the consumer attributes interleaved events to the right sub-agent
  // by key, not by "whichever opened last".
  return {
    // Stall-watchdog liveness signal. onTurnStart fires immediately BEFORE each
    // model call, so a hung `generateText` leaves this as the last stamp and the
    // watchdog fires after the deadline. Not forwarded to the parent driver
    // (sub-agent turn-starts never were) — it only feeds the local watchdog.
    onTurnStart: () => bumpProgress,
    // Stamp liveness at the START of every tool call too — not just on completion
    // (onAfterToolCall). A turn's LLM phase (bounded by LLM_REQUEST_TIMEOUT_MS,
    // which retries+bumps) plus a long tool can together exceed the stall
    // deadline while each phase is fine; bumping at the tool boundary resets the
    // clock so the watchdog measures time-since-the-last-step, not time-since-
    // turn-start, and a working agent isn't killed mid-tool. Still forwards the
    // parent's allow/deny decision (or a default continue when there's no parent).
    onBeforeToolCall: (e: AgentBeforeToolCallEvent) =>
      bumpProgress.pipe(
        Effect.zipRight(
          parentBefore !== undefined
            ? parentBefore({ ...e, subAgentNodeId: nodeId })
            : Effect.succeed<BeforeToolCallDecision>({ action: "continue" }),
        ),
      ),
    onAfterToolCall: (e) =>
      Effect.gen(function* () {
        yield* bumpProgress
        if (parentAfter !== undefined) yield* parentAfter({ ...e, subAgentNodeId: nodeId })
        yield* trackFiles(e)
      }),
    onAssistantMessage: (event) => {
      const u = event.usage
      const track =
        u !== undefined
          ? Ref.update(usageRef, (acc) => ({
              inputTokens: u.inputTokens,
              outputTokens: acc.outputTokens + u.outputTokens,
              cacheReadTokens: u.cacheReadTokens,
            })).pipe(Effect.zipRight(drainPool(pool, u)))
          : Effect.void
      // Keep THIS run's latest narration for the exit finalizer — only its own
      // (a nested child's forwarded event carries `subAgentNodeId`; stamping it
      // here would credit the parent with the child's text).
      const noteText =
        event.subAgentNodeId === undefined && event.text.trim().length > 0
          ? Ref.set(lastTextRef, event.text)
          : Effect.void
      // Forward inner narration to the parent's event stream too — the TUI
      // shows it live when this node's session is open in the preview (the
      // pump keeps it off the parent rail; usage stays node-local).
      return bumpProgress.pipe(
        Effect.zipRight(noteText),
        Effect.zipRight(
          parentAssistant !== undefined
            ? parentAssistant({ ...event, subAgentNodeId: nodeId, subAgentRole: role }).pipe(
                Effect.zipRight(track),
              )
            : track,
        ),
      )
    },
    onShouldStopAfterTurn: () =>
      Effect.gen(function* () {
        const spent = yield* poolExhausted(pool)
        if (spent) yield* Ref.set(budgetStopRef, true)
        return spent
      }),
    // Inbox drain: at each turn boundary, fold any messages sent to THIS node
    // (by a sibling agent or the human) into its context as inbound user turns.
    // Ephemeral (not persisted to the node) — the agent's reply is what's saved.
    onTransformContext: (messages) =>
      Effect.gen(function* () {
        const inbox = yield* bus.drain(nodeId)
        return inbox.length === 0 ? messages : [...messages, ...inboxToMessages(inbox)]
      }),
    ...(parent?.onSubAgentStart !== undefined
      ? { onSubAgentStart: parent.onSubAgentStart }
      : {}),
    ...(parent?.onSubAgentEnd !== undefined
      ? { onSubAgentEnd: parent.onSubAgentEnd }
      : {}),
    ...(parent?.onSkillLoad !== undefined
      ? { onSkillLoad: parent.onSkillLoad }
      : {}),
    // Helper-tier spend inside a sub-agent's loop (compaction summaries) still
    // belongs on the session ledger — forward it.
    ...(parent?.onHelperUsage !== undefined
      ? { onHelperUsage: parent.onHelperUsage }
      : {}),
  }
}

interface RunSpawnedArgs<R> {
  readonly store: ContextTreeStore["Type"]
  readonly shell: Shell["Type"]
  readonly bus: AgentBus
  readonly displayRoot: string
  readonly opts: BuildScopeRuntimeOptions
  readonly hooks: AgentHooks<R> | undefined
  readonly nodeId: ContextNodeId
  readonly folder: string
  readonly task: string
  /** Display name from the spawner — the label every event/UI surface uses. */
  readonly title?: string
  /** The agent ROLE this run plays — overrides prompt body, toolkit, model.
   *  Absent ⇒ the generic folder-scoped coder (base tools + `run_agent`). */
  readonly definition?: AgentDefinition
  readonly seedMessages: ReadonlyArray<AgentMessage>
  readonly parentDepth: number
  /** The node's parent in the context tree (for consumer-side nesting). */
  readonly parentNodeId: ContextNodeId | null
  readonly rootConversationId: ConversationId | null
  readonly tokenPool: TokenPool
  /** The parent run's context so we can propagate prompt identity, step cap, etc. */
  readonly runContext: RunContext
  /** Live per-run step cap (`Settings.subAgentMaxSteps` via `RunContext`). */
  readonly maxSteps?: number
  /** Compaction budget (chars) per tool-result string, via `RunContext`. */
  readonly toolResultMaxChars?: number
}

/**
 * Run a spawned sub-agent over its already-created node: render the scoped
 * system prompt (+ ambient `SCOPE.md` body), run the loop with the generic
 * toolkit under the folder's `ScopeBinding`, persist the produced tail to the
 * node, record the return, and emit the sub-agent start/end events (carrying the
 * node id). Re-seeds `RunContextRef` so nested `run_agent` calls see this node
 * as their parent.
 *
 * The whole run holds the folder's lock: spawns into *different* folders fan
 * out in parallel (the loop resolves a step's tool calls concurrently), while
 * same-folder spawns — which would race on the same files — queue. Start/end
 * events fire inside the lock, so a queued same-name run never interleaves
 * its lifecycle with the one before it.
 */
const runSpawnedAgent = <R>(args: RunSpawnedArgs<R>) => {
  const definition = args.definition
  // Set true the moment EITHER terminal path records its return (ok / error).
  // The exit finalizer reads it: a run that exits WITHOUT having recorded one
  // was interrupted (Esc / :stop / teardown) or died, so the finalizer records
  // an `error` return + notifies the parent itself — otherwise the DB node
  // stays `running` forever and the parent is never told (markDone only tears
  // the mailbox down). Created OUTSIDE the body so the finalizer can read it.
  const returnRecordedRef = Ref.unsafeMake(false)
  // Stall watchdog state, all OUTSIDE the body so the watchdog fiber (which
  // races the body) and the finalizer can read them.
  //  - progressRef: epoch-ms of the last observable step (turn start / tool
  //    result / narration / LLM retry). Initialised at body start; the watchdog
  //    compares now − this against the deadline.
  //  - stalledRef: set true iff the watchdog tripped, so the finalizer records
  //    STALL_NOTE (a deliberate stop) rather than the generic INTERRUPTED_NOTE.
  //  - lastTextRef / filesRef / usageRef: the run's produced work so far — the
  //    finalizer preserves them on an abnormal exit instead of recording an
  //    empty error (the watchdog once discarded FINISHED work as "[stalled]").
  const progressRef = Ref.unsafeMake(0)
  const stalledRef = Ref.unsafeMake(false)
  const lastTextRef = Ref.unsafeMake("")
  const filesRef = Ref.unsafeMake<ReadonlyArray<string>>([])
  const usageRef = Ref.unsafeMake<ContextUsage>({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
  })
  const bumpProgress = Clock.currentTimeMillis.pipe(Effect.flatMap((t) => Ref.set(progressRef, t)))
  const body = Effect.gen(function* () {
    const { store, displayRoot, opts, hooks, nodeId, folder, task, seedMessages } = args
    const label = args.title ?? (basename(folder) || folder)

    if (hooks?.onSubAgentStart) {
      yield* hooks.onSubAgentStart({
        name: label,
        task,
        nodeId,
        role: definition?.role ?? "general",
        ...(args.parentNodeId !== null ? { parentNodeId: args.parentNodeId } : {}),
      })
    }
    // The bus key of whoever spawned this run — its node, else the root
    // conversation. The completion message + a parent's `wait_for_agents` /
    // `childrenOf` are routed by it. (`run_agent` pre-registers with the same
    // key before forking; this re-affirms idempotently.)
    const parentKey: string | null =
      args.parentNodeId ?? args.rootConversationId ?? null
    // Register a live mailbox so siblings/the human can message this run; torn
    // down on every exit path (success, failure, interrupt) by the ensuring below.
    yield* args.bus.markRunning(nodeId, label, { parentKey })
    const budgetStopRef = yield* Ref.make(false)
    // Seed the progress clock NOW, before any model call, so the watchdog
    // measures from a real timestamp (not epoch 0) on its first tick.
    yield* bumpProgress
    const innerHooks = makeInnerHooks(
      hooks,
      nodeId,
      definition?.role ?? "general",
      filesRef,
      usageRef,
      args.tokenPool,
      budgetStopRef,
      args.bus,
      bumpProgress,
      lastTextRef,
    )

    const binding: ScopeBinding = {
      rootDir: folder,
      displayRoot,
      enforceWrite: true,
      allowBash: opts.allowBash ?? true,
      // Deterministic web-lookup brake for this spawned worker (config via
      // Settings.subAgentFetchBudget, inherited down the subtree on RunContext).
      fetchBudget:
        args.runContext.subAgentFetchBudget ?? DEFAULT_SUB_AGENT_FETCH_BUDGET,
    }
    const scopeBody = yield* getScopePromptBody(folder)
    // Role instructions (if any) lead, then the folder's ambient SCOPE.md body —
    // both land in renderScopeSystemPrompt's instructions slot, so the scope /
    // write-confinement / return-contract scaffold always wraps them.
    const combinedBody = [definition?.body, scopeBody]
      .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      .join("\n\n")
    // The role's ACTUAL tools — so the prompt's `# Tools` block and the fleet /
    // coordination sections render from exactly what this agent has (no role ⇒
    // the full generic toolkit). Reused below to build the matching toolkit, so
    // prompt and toolkit can't drift.
    const roleEntries = definition !== undefined ? roleToolEntries(definition) : undefined
    const toolNames =
      roleEntries !== undefined
        ? roleEntries.map(([n]) => n)
        : Object.keys(genericToolkit.tools)
    const system = renderScopeSystemPrompt({
      name: label,
      rootDir: folder,
      displayRoot,
      body: combinedBody,
      now: new Date(),
      toolNames,
      // Give a coordinator (a role with run_agent) the roster so it can name its
      // specialists; leaf workers ignore it.
      agents: opts.agents,
      // The project-knowledge index rides into every sub-agent too — they read
      // the distilled rationale and can record new decisions via `remember`.
      memory: opts.memory,
      // The project's own conventions (AGENT.md / CONSTRAINTS.md, pre-rendered by
      // the driver) ride down too — so a coder inherits *this* project's
      // build/verify command and hard rules instead of guessing.
      ...(opts.instructions !== undefined ? { instructions: opts.instructions } : {}),
    })
    const parentPrompt = args.runContext.prompt
    const childPrompt: Prompt | undefined =
      parentPrompt !== undefined
        ? {
            ...parentPrompt,
            name: `${parentPrompt.name}:${label}`,
          }
        : undefined

    // Toolkit: a role with an allowlist runs a SUBSET of tools — build the
    // subset toolkit (what the model sees) AND a matching handler subset (from
    // the same full handler record), so the two never disagree. No role ⇒ the
    // full generic toolkit (base tools + run_agent).
    const handlers = buildGenericHandlers(binding, opts, hooks, args.bus)
    const useToolkit =
      roleEntries !== undefined
        ? (Toolkit.make(
            ...(roleEntries.map(([, d]) => d) as ReadonlyArray<Tool.Any>),
          ) as unknown as Toolkit.Toolkit<Record<string, Tool.Any>>)
        : genericToolkit
    const useLayer =
      roleEntries !== undefined
        ? (useToolkit.toLayer(
            handlers.pipe(
              Effect.map((full) => {
                const allow = new Set(roleEntries.map(([n]) => n))
                return Object.fromEntries(
                  Object.entries(full as Record<string, unknown>).filter(([k]) =>
                    allow.has(k),
                  ),
                ) as never
              }),
            ),
          ) as ScopeRuntime["handlerLayer"])
        : (genericToolkit.toLayer(handlers) as ScopeRuntime["handlerLayer"])
    const childRc = {
      rootConversationId: args.rootConversationId,
      parentNodeId: nodeId,
      depth: args.parentDepth + 1,
      tokenPool: args.tokenPool,
      ...(childPrompt !== undefined ? { prompt: childPrompt } : {}),
      ...(args.maxSteps !== undefined ? { subAgentMaxSteps: args.maxSteps } : {}),
      // Inherit the nesting-depth cap down the subtree (seeded once at run start
      // from Settings.subAgentMaxDepth), so the spawn guard reads the same config
      // at every level.
      ...(args.runContext.subAgentMaxDepth !== undefined
        ? { subAgentMaxDepth: args.runContext.subAgentMaxDepth }
        : {}),
      // Inherit the per-sub-agent web-lookup budget down the subtree, so a
      // grandchild researcher is capped the same as a child (the value is per
      // AGENT-run via its own binding counter, but the cap is shared config).
      ...(args.runContext.subAgentFetchBudget !== undefined
        ? { subAgentFetchBudget: args.runContext.subAgentFetchBudget }
        : {}),
      ...(args.toolResultMaxChars !== undefined
        ? { toolResultMaxChars: args.toolResultMaxChars }
        : {}),
      // Inherit the root agent's compression policy (the loop reads it off
      // RunContext when no per-call override is given).
      ...(args.runContext.compression !== undefined
        ? { compression: args.runContext.compression }
        : {}),
      // The sub-agent runs on the ROLE it was spawned as — `code` for writing
      // code, `general` (the default) for research / analysis / orchestration.
      // The role comes from the definition (a named role's tier, the inline
      // `role`, or the per-spawn `role` param — resolved in applyInlineDefinition);
      // it is NEVER a free model the model emitted. Re-seeded each spawn (not
      // inherited) so a deeper spawn picks its own role. The router reads it off
      // RunContextRef to resolve the role's pinned model.
      modelRole: (definition?.role ?? "general") satisfies AgentModelRole,
      // Carry the run's frozen role→model map + the mission down the subtree, so
      // the fleet stays on the models pinned at run start (cache-safe) and every
      // sub-agent can be reminded of the overall goal.
      ...(args.runContext.pinnedModels !== undefined
        ? { pinnedModels: args.runContext.pinnedModels }
        : {}),
      ...(args.runContext.mission !== undefined
        ? { mission: args.runContext.mission }
        : {}),
      // Inherited verbatim like the mission: a headless (unattended) run's whole
      // subtree must know it's unattended, so a deep spawn's approval also parks
      // + denies rather than blocking on a human who isn't there.
      ...(args.runContext.interactionPolicy !== undefined
        ? { interactionPolicy: args.runContext.interactionPolicy }
        : {}),
      // Carry the retry-notice sink down so a sub-agent's backoff is visible too,
      // and count each retry as PROGRESS for the stall watchdog: a call weathering
      // a transient overload (429s, slow gateway) is working, not frozen, so it
      // must not be killed. Always wrapped (even with no parent sink) so the bump
      // happens; the forward is conditional.
      onLlmRetry: (e: AgentLlmRetryEvent) => {
        const parentSink = args.runContext.onLlmRetry
        return parentSink !== undefined
          ? bumpProgress.pipe(Effect.zipRight(parentSink(e)))
          : bumpProgress
      },
      // And the background-output sink, so a sub-agent's bg process is visible too.
      ...(args.runContext.onBgOutput !== undefined
        ? { onBgOutput: args.runContext.onBgOutput }
        : {}),
      // Read-only research subtree: set when THIS spawn is a research-coordinator,
      // inherited once set — so every spawn beneath it stays investigation-only and
      // implementation flows back to the root (see RunContext.researchSubtree).
      ...(args.runContext.researchSubtree === true || definition?.name === RESEARCH_COORDINATOR_NAME
        ? { researchSubtree: true }
        : {}),
    }

    // One attempt of the scoped loop over a message buffer — reused verbatim for
    // the first run AND each coordinator gate-driven retry, so a retry inherits
    // the same toolkit, layer, pinned models (via childRc), and compaction policy.
    const runAttempt = (msgs: ReadonlyArray<AgentMessage>) =>
      runAgentLoop({
        system,
        messages: msgs,
        toolkit: useToolkit,
        maxSteps: args.maxSteps ?? opts.maxSteps ?? DEFAULT_SUB_AGENT_MAX_STEPS,
        ...(args.toolResultMaxChars !== undefined
          ? { toolResultMaxChars: args.toolResultMaxChars }
          : {}),
        hooks: innerHooks,
      }).pipe(
        Effect.provide(useLayer),
        Effect.locally(RunContextRef, childRc),
        Effect.map((r) => ({ ok: true as const, r })),
        Effect.catchAll((e) => Effect.succeed({ ok: false as const, e })),
        // Name the sub-agent subtree in the trace waterfall. Its turns /
        // llm.generate / tool spans already nest beneath via Effect span
        // propagation; this labels the whole branch with its node + folder so
        // parallel fan-outs are distinguishable.
        Effect.withSpan(subagentSpanName(label, folder, args.parentDepth + 1), {
          attributes: {
            ...agentSpanAttributes("subagent", args.rootConversationId),
            "agent.subagent.node_id": nodeId,
            "agent.subagent.depth": args.parentDepth + 1,
            "agent.subagent.folder": folder,
            "agent.subagent.title": label,
          },
        }),
      )

    // Persist a produced tail to the node the moment it lands (incremental, so a
    // gate retry's earlier attempts are durable; the terminal recordReturn no
    // longer bulk-appends).
    const persistNodeTail = (msgs: ReadonlyArray<AgentMessage>) =>
      Effect.forEach(msgs, (m) => store.append(nodeId, m))

    const outcome = yield* runAttempt(seedMessages)
    if (outcome.ok) yield* persistNodeTail(outcome.r.newTail)
    // (No per-coordinator gate here any more — gating is ONE tier, at the root
    // (`driveLoop`), judging the aggregate deliverable. The old lead-tier gate
    // ran a multi-minute Opus subprocess inside this run's 180s stall-watchdog
    // window with no progress stamps, so finished leads were killed as
    // "[stalled]" and their work discarded.)

    const files = yield* Ref.get(filesRef)
    const usage = yield* Ref.get(usageRef)
    const hasUsage = usage.outputTokens > 0 || usage.inputTokens > 0

    // Staleness stamp: the world this node's context describes. A later
    // resume/branch compares it to the then-current HEAD (best-effort —
    // non-git workspaces just never stamp).
    const wsRef = yield* getWorkspaceRef(args.displayRoot).pipe(
      Effect.provideService(Shell, args.shell),
    )
    const stamp = wsRef !== undefined ? { workspaceRef: wsRef } : {}

    if (outcome.ok) {
      // The produced tail was already persisted incrementally above (first
      // attempt + each gate retry) — don't bulk-append it again here.
      // A budget OR step-cap stop is an *ok* outcome with a partial result —
      // say so, so the parent model (and the human in :tree) knows not to
      // trust it as complete. Without the step marker, a capped run's
      // mid-thought last sentence reads as the deliverable.
      const stoppedByBudget = yield* Ref.get(budgetStopRef)
      const stopNote = stoppedByBudget
        ? BUDGET_STOP_NOTE
        : outcome.r.stoppedAtMaxSteps === true
          ? STEP_STOP_NOTE
          : undefined
      const summary =
        stopNote !== undefined
          ? `${outcome.r.finalText}\n\n${stopNote}`.trim()
          : outcome.r.finalText
      yield* store.recordReturn(nodeId, {
        status: "ok",
        summary,
        filesChanged: files,
        ...(hasUsage ? { usage } : {}),
        ...stamp,
      })
      // Mark the return recorded so the exit finalizer doesn't double-record it.
      yield* Ref.set(returnRecordedRef, true)
      // Deliver the outcome to the bus FIRST: wakes a parent's `wait_for_agents`,
      // delivers/buffers a completion in the parent's inbox + the blackboard, and
      // records the terminal result. This MUST precede `onSubAgentEnd` — that
      // event triggers the daemon's `onTopLevelDone` auto-resume, which drains the
      // parent's inbox; deliver after, and the resume races an empty inbox.
      // (`markDone` below is then a no-op — `complete` already removed the entry.)
      yield* args.bus.complete(nodeId, { status: "ok", summary, filesChanged: files })
      if (hooks?.onSubAgentEnd) {
        yield* hooks.onSubAgentEnd({
          name: label,
          nodeId,
          ok: true,
          summary,
          filesChanged: files,
          ...(hasUsage ? { usage } : {}),
        })
      }
      return { summary, filesChanged: files, nodeId }
    }

    const f = toFailure(outcome.e)
    const summary = f.message ? `${f.error}: ${f.message}` : f.error
    yield* store.recordReturn(nodeId, {
      status: "error",
      summary,
      filesChanged: files,
      ...(hasUsage ? { usage } : {}),
      ...stamp,
    })
    // Mark the return recorded so the exit finalizer doesn't double-record it.
    yield* Ref.set(returnRecordedRef, true)
    // Same ordering as the ok path: deliver to the bus before the event that
    // triggers the auto-resume, so a parent draining its inbox sees the failure.
    yield* args.bus.complete(nodeId, { status: "error", summary, filesChanged: files })
    if (hooks?.onSubAgentEnd) {
      yield* hooks.onSubAgentEnd({
        name: label,
        nodeId,
        ok: false,
        summary,
        filesChanged: files,
        ...(hasUsage ? { usage } : {}),
      })
    }
    return yield* Effect.fail(f)
  })
  // No folder lock: writers are sequenced at the ORCHESTRATOR (it spawns coders
  // one at a time and waits between them — read-only research/review fans out in
  // parallel). A lock here held for the whole run was invisible + unrecoverable
  // (a hung agent stranded its same-folder siblings); sequencing lives where it's
  // observable (wait_for_agents timeouts).
  //
  // Exit finalizer (runs on EVERY exit — success, failure, interrupt, defect):
  //  - Normal terminal paths (ok / error) already recorded the return AND
  //    notified the parent via `bus.complete`, so `returnRecordedRef` is true:
  //    just tear the mailbox down (markDone is a no-op — complete already
  //    removed the running entry).
  //  - Interrupted / died before a terminal path ⇒ the Ref is still false: the
  //    DB node would otherwise stay `running` forever and the parent would never
  //    hear about it (markDone only tears down the mailbox without notifying).
  //    So record the return AND `bus.complete` — PRESERVING the run's produced
  //    work (last assistant text, filesChanged, usage). The old finalizer
  //    hardcoded an empty error, so a watchdog kill discarded FINISHED work as
  //    "[stalled]" — the single biggest failure bucket in the run forensics.
  //    A stalled run WITH text is an ok-with-caveat (the note marks it partial);
  //    everything else stays an error, but keeps whatever text/files existed.
  // Everything here is failure-safe (Effect.ignore / catchAll) so teardown never
  // throws — the finalizer must always complete even mid-interruption.
  const finalize = Effect.gen(function* () {
    const recorded = yield* Ref.get(returnRecordedRef)
    if (recorded) {
      yield* args.bus.markDone(args.nodeId).pipe(Effect.ignore)
      return
    }
    const stalled = yield* Ref.get(stalledRef)
    const lastText = yield* Ref.get(lastTextRef)
    const files = yield* Ref.get(filesRef)
    const usage = yield* Ref.get(usageRef)
    const hasUsage = usage.outputTokens > 0 || usage.inputTokens > 0
    const note = stalled ? STALL_NOTE : INTERRUPTED_NOTE
    const hasText = lastText.trim().length > 0
    const summary = hasText ? `${lastText}\n\n${note}` : note
    // A run the watchdog stopped AFTER it produced narration finished its
    // thinking — deliver the text as a partial ok (the note carries the caveat)
    // instead of throwing the work away. A silent stall / an interrupt stays an
    // error, but still reports any text + files it managed to land.
    const status = stalled && hasText ? ("ok" as const) : ("error" as const)
    yield* args.store
      .recordReturn(args.nodeId, {
        status,
        summary,
        filesChanged: files,
        ...(hasUsage ? { usage } : {}),
      })
      .pipe(Effect.ignore)
    yield* args.bus
      .complete(args.nodeId, {
        status,
        summary,
        filesChanged: files,
      })
      .pipe(Effect.ignore)
  }).pipe(Effect.catchAll(() => Effect.void))

  // The stall watchdog: a fiber that wakes every WATCHDOG_TICK_MS and fails the
  // moment the run has gone SUBAGENT_STALL_DEADLINE_MS without progress (no turn
  // start, tool result, narration, or LLM retry — all stamp `progressRef`). It
  // fails (never succeeds), so racing it against `body` interrupts a parked body;
  // the body's exit then runs `finalize`, which reads `stalledRef` and records a
  // clear STALL error so the parent's `wait_for_agents` unblocks. This closes the
  // hole BOTH other backstops miss: the exit finalizer needs the fiber to EXIT (a
  // parked fiber hasn't), and the sweeper needs it OFF the bus (a parked fiber is
  // still on it). Without this a hung first model call stranded the node `running`
  // with zero turns while its parent looped blind.
  const deadlineMs = args.opts.stallDeadlineMs ?? SUBAGENT_STALL_DEADLINE_MS
  // Tick often enough to land the kill promptly once stalled, capped at the
  // standard cadence (so a tiny injected deadline ticks proportionally fast).
  const tickMs = Math.min(WATCHDOG_TICK_MS, Math.max(10, Math.floor(deadlineMs / 4)))
  const watchdog: Effect.Effect<never, Failure> = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(`${tickMs} millis`)
      const now = yield* Clock.currentTimeMillis
      const last = yield* Ref.get(progressRef)
      if (now - last >= deadlineMs) {
        yield* Ref.set(stalledRef, true)
        return yield* Effect.fail<Failure>({
          error: "SubAgentStalled",
          message: `no progress for ${Math.round((now - last) / 1000)}s`,
        })
      }
    }
  })

  // raceFirst: whichever settles first wins and interrupts the other. A healthy
  // body settles first (watchdog interrupted, no-op). A stalled body never
  // settles, so the watchdog's failure wins and interrupts the body. `onExit`
  // wraps the WHOLE race so `finalize` is AWAITED to completion before the fiber
  // settles — it records the STALL error + notifies the parent on every exit
  // path (success → markDone, normal error → markDone, stall/interrupt → record).
  // The Failure propagates to the fork's catchAll (it swallows all sub-agent
  // errors), so nothing leaks.
  return body.pipe(
    Effect.raceFirst(watchdog),
    Effect.onExit(() => finalize),
  )
}

/** The model's `run_agent` result: the work happens in the background, so the
 *  call returns the spawned node's handle, never its outcome. */
interface SpawnHandle {
  readonly nodeId: ContextNodeId
  readonly name: string
  readonly status: "running"
}

/** The `run_agent` handler: spawn / resume / branch a folder-scoped sub-agent,
 *  in the BACKGROUND. Each branch builds the run, then `launch` forks it as a
 *  supervised fiber and returns its handle immediately — the spawner never
 *  blocks on the subtree (that's what kept a parent "hung" while its fleet
 *  worked). The result is gathered later via `wait_for_agents` / the inbox. */
const makeRunAgentHandler =
  <R>(
    store: ContextTreeStore["Type"],
    shell: Shell["Type"],
    bus: AgentBus,
    displayRoot: string,
    opts: BuildScopeRuntimeOptions,
    hooks: AgentHooks<R> | undefined,
  ) => {
    // Fork a built run as a background fiber and return its handle. Pre-registers
    // the child on the bus (so a sibling can address it the instant we return)
    // and records its fiber (so `:stop` / teardown can interrupt it). The run
    // itself records its return + completion on every exit path, so a failure is
    // already captured there — swallow it from the daemon to avoid an unhandled
    // fiber error.
    const launch = (spawnArgs: RunSpawnedArgs<R>) =>
      Effect.gen(function* () {
        const label = spawnArgs.title ?? (basename(spawnArgs.folder) || spawnArgs.folder)
        const parentKey: string | null =
          spawnArgs.parentNodeId ?? spawnArgs.rootConversationId ?? null
        yield* bus.markRunning(spawnArgs.nodeId, label, { parentKey })
        const fiber = yield* Effect.forkDaemon(
          runSpawnedAgent(spawnArgs).pipe(Effect.catchAll(() => Effect.void), Effect.asVoid),
        )
        yield* bus.setFiber(spawnArgs.nodeId, fiber)
        const handle: SpawnHandle = {
          nodeId: spawnArgs.nodeId,
          name: label,
          status: "running",
        }
        return handle
      })

    return (params: {
      readonly name: string
      readonly folder: string
      readonly task: string
      readonly seedFromNode?: string
      readonly seedMode?: "resume" | "branch" | "handoff"
      readonly agent?: string
      readonly instructions?: string
      readonly tools?: ReadonlyArray<string>
      readonly role?: AgentModelRole
    }) =>
    Effect.gen(function* () {
      const rc = yield* FiberRef.get(RunContextRef)
      // Config-driven: Settings.subAgentMaxDepth (via RunContext) wins, then the
      // build-time opts override, then the built-in default.
      const maxDepth = rc.subAgentMaxDepth ?? opts.maxDepth ?? DEFAULT_SUB_AGENT_MAX_DEPTH
      if (rc.depth >= maxDepth) {
        return yield* Effect.fail({
          error: "MaxDepthReached",
          message: `sub-agent nesting limit (${maxDepth}) reached — do this part yourself.`,
        })
      }
      // Depth bounds termination; the shared pool bounds spend. A drained
      // pool refuses new spawns (model-readable, like every other failure
      // here) — running sub-agents stop at their next turn boundary.
      if (yield* poolExhausted(rc.tokenPool)) {
        return yield* Effect.fail(budgetExhaustedFailure)
      }
      const { name, folder, task, seedFromNode, seedMode, agent, instructions, tools, role } =
        params
      // The model-given display name; blank/absent (a stale provider replaying
      // an old-schema call) degrades to the folder basename.
      const title =
        typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined

      // Coordinator-only routing: when the ROOT (depth 0) is an orchestrator (a
      // lead is in the roster), it may only spawn a LEAD — never a bare-role
      // worker. The lead owns staffing, sequencing, the gate, and the retry loop.
      // (A resume/branch of an existing node is exempt — that targets a node, not
      // a fresh worker.) Model-readable failure so it re-routes through a coordinator.
      const hasLead = opts.agents.some((a) => LEAD_AGENT_NAMES.includes(a.name))
      const isResume = seedFromNode !== undefined && seedFromNode.trim().length > 0
      if (
        rc.depth === 0 &&
        hasLead &&
        !isResume &&
        (agent === undefined || !LEAD_AGENT_NAMES.includes(agent))
      ) {
        return yield* Effect.fail({
          error: "RouteThroughCoordinator",
          message:
            "You are the orchestrator — route work through a lead, not a bare worker. " +
            'Spawn `run_agent({ agent: "coordinator", folder, task })` for code work, or ' +
            '`run_agent({ agent: "research-coordinator", folder, task })` for investigation, ' +
            "and let IT staff and sequence the specialists. Re-issue this spawn with `agent` set to a coordinator.",
        })
      }

      // Resolve the requested role (if any). A named-but-unknown agent is a
      // model-facing failure — silently ignoring a requested role hides a real
      // mistake (mirrors read_skill's UnknownSkill). Absent ⇒ generic spawn.
      // Then layer any INLINE definition (instructions/tools/role) on top, so a
      // task-tailored agent flows through the same `definition` slot as a role.
      // `role` is only the model TIER (general | code) — never a specific model.
      const baseDefinition = yield* resolveAgent(opts.agents, agent)
      let definition = applyInlineDefinition(baseDefinition, { instructions, tools, role })

      // Read-only research subtree: a research-coordinator investigates and RETURNS
      // a report — it must not spawn a code lead or mint write-capable workers
      // ("fix the findings" is the ROOT's call, in a fresh turn). Refuse a code
      // coordinator outright; constrain every other spawn to read-only. (Without
      // this, a research-coordinator spawned a full-toolkit worker that wrote code.)
      if (rc.researchSubtree === true) {
        if (agent === CODE_COORDINATOR_NAME) {
          return yield* Effect.fail({
            error: "ResearchStaysReadOnly",
            message:
              "You are leading a read-only investigation — you don't implement or spawn coders. List the fixes you'd make as concrete RECOMMENDATIONS in your final report; the root will implement them in a fresh turn (with its own budget).",
          })
        }
        definition = constrainToReadOnly(definition)
      }

      // Resume / branch an existing node.
      if (seedFromNode !== undefined && seedFromNode.trim().length > 0) {
        const nodeId = yield* Schema.decodeUnknown(ContextNodeId)(seedFromNode.trim()).pipe(
          Effect.mapError(() => ({
            error: "InvalidNodeId",
            message: `'${seedFromNode}' is not a valid context-node id.`,
          })),
        )
        const node = yield* store.get(nodeId)
        // The node's context is a cache of an older world: if HEAD moved
        // since it last ran, prepend what changed in its folder so the model
        // re-reads instead of trusting stale in-context file contents.
        const brief = yield* buildStalenessBrief({
          workspaceDir: displayRoot,
          nodeFolder: node.folder,
          stampedRef: node.workspaceRef,
        }).pipe(Effect.provideService(Shell, shell))
        const taskMsg = brief !== undefined ? `${brief}\n\n${task}` : task
        if (seedMode === "resume") {
          yield* store.append(nodeId, { role: "user", content: taskMsg })
          const seedMessages = yield* store.listMessages(nodeId)
          return yield* launch({
            store, shell, bus, displayRoot, opts, hooks, nodeId, folder: node.folder, task, seedMessages,
            // The fresh name describes the follow-up; the node keeps its own.
            ...(title !== undefined ? { title } : node.title !== undefined ? { title: node.title } : {}),
            ...(definition !== undefined ? { definition } : {}),
            parentDepth: rc.depth, parentNodeId: node.parentId,
            rootConversationId: rc.rootConversationId,
            tokenPool: rc.tokenPool,
            runContext: rc,
            ...(rc.subAgentMaxSteps !== undefined ? { maxSteps: rc.subAgentMaxSteps } : {}),
            ...(rc.toolResultMaxChars !== undefined ? { toolResultMaxChars: rc.toolResultMaxChars } : {}),
          })
        }
        const sourceMsgs = yield* store.listMessages(nodeId)
        // "handoff": continuity at a fraction of the tokens — a generated
        // brief of the source node's work seeds a FRESH node instead of its
        // verbatim history. "branch" (default): the full history, copied.
        const seedMessages: ReadonlyArray<AgentMessage> =
          seedMode === "handoff"
            ? [
                ...missionPreamble(rc.mission),
                handoffToMessage(yield* generateHandoffBrief(sourceMsgs)),
                { role: "user", content: taskMsg },
              ]
            : // branch: the source's verbatim history already carries the mission
              // preamble from its own fresh spawn — don't double it.
              [...sourceMsgs, { role: "user", content: taskMsg }]
        const childId = yield* store.spawn({
          parentId: nodeId,
          rootConversationId: rc.rootConversationId,
          edgeKind: "branched",
          folder: node.folder,
          displayRoot,
          ...(title !== undefined ? { title } : {}),
          seed:
            seedMode === "handoff"
              ? { kind: "handoff", sourceNodeId: nodeId, preview: clip(task, 80) }
              : { kind: "selection", sourceNodeId: nodeId, turnCount: sourceMsgs.length },
          seedMessages,
        })
        return yield* launch({
          store, shell, bus, displayRoot, opts, hooks, nodeId: childId, folder: node.folder, task, seedMessages,
          ...(title !== undefined ? { title } : {}),
          ...(definition !== undefined ? { definition } : {}),
          parentDepth: rc.depth, parentNodeId: nodeId,
          rootConversationId: rc.rootConversationId,
          tokenPool: rc.tokenPool,
          runContext: rc,
          ...(rc.subAgentMaxSteps !== undefined ? { maxSteps: rc.subAgentMaxSteps } : {}),
          ...(rc.toolResultMaxChars !== undefined ? { toolResultMaxChars: rc.toolResultMaxChars } : {}),
        })
      }

      // Fresh spawn. Seed the overall mission (if any) ahead of the task, so a
      // leaf agent knows the goal its piece serves even when the brief is terse.
      const folderAbs = resolve(displayRoot, folder)
      const seedMessages: ReadonlyArray<AgentMessage> = [
        ...missionPreamble(rc.mission),
        { role: "user", content: task },
      ]
      const nodeId = yield* store.spawn({
        parentId: rc.parentNodeId,
        rootConversationId: rc.rootConversationId,
        edgeKind: "spawned",
        folder: folderAbs,
        displayRoot,
        ...(title !== undefined ? { title } : {}),
        seed: { kind: "task", preview: clip(task, 80) },
        seedMessages,
      })
      return yield* launch({
        store, shell, bus, displayRoot, opts, hooks, nodeId, folder: folderAbs, task, seedMessages,
        ...(title !== undefined ? { title } : {}),
        ...(definition !== undefined ? { definition } : {}),
        parentDepth: rc.depth, parentNodeId: rc.parentNodeId,
        rootConversationId: rc.rootConversationId,
        tokenPool: rc.tokenPool,
        runContext: rc,
        ...(rc.subAgentMaxSteps !== undefined ? { maxSteps: rc.subAgentMaxSteps } : {}),
        ...(rc.toolResultMaxChars !== undefined ? { toolResultMaxChars: rc.toolResultMaxChars } : {}),
      })
    }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e))))
  }

/**
 * Build the generic handler record for a `ScopeBinding`: the base coding
 * handlers (scope-confined writes/bash) + the `run_agent` handler. Resolves
 * `FileSystem`/`Shell`/`Http`/`WebSearch` (via `makeCodingHandlers`) and
 * `ContextTreeStore` from context at layer-build; the handler's per-call
 * `LanguageModel` need is resolved from the ambient runtime (as before).
 */
const buildGenericHandlers = <R>(
  binding: ScopeBinding,
  opts: BuildScopeRuntimeOptions,
  hooks: AgentHooks<R> | undefined,
  bus: AgentBus,
) =>
  Effect.gen(function* () {
    const base = yield* makeCodingHandlers(binding, opts.skills, opts.memory)
    const store = yield* ContextTreeStore
    const shell = yield* Shell
    const http = yield* Http
    const fs = yield* FileSystem
    const approval = yield* Approval
    const run_agent = makeRunAgentHandler(store, shell, bus, binding.displayRoot, opts, hooks)

    // Cron as a tool: the orchestrator schedules its own follow-up / recurring
    // work. Validates the expression, writes the job to the shared cron list
    // (the same one :schedule + the tick read), returns the id.
    const schedule = (params: {
      readonly cron: string
      readonly task: string
      readonly folder?: string
      readonly agent?: string
    }) =>
      Effect.gen(function* () {
        if (parseCron(params.cron) === undefined) {
          return yield* Effect.fail({
            error: "InvalidCron",
            message: `'${params.cron}' is not a valid 5-field cron expression ('min hour dom month dow').`,
          })
        }
        const at = yield* Clock.currentTimeMillis
        const job: ScheduledJob = {
          id: crypto.randomUUID(),
          cron: params.cron,
          cwd: binding.displayRoot,
          folder: params.folder !== undefined && params.folder.length > 0 ? params.folder : ".",
          prompt: params.task,
          ...(params.agent !== undefined && params.agent.length > 0 ? { agent: params.agent } : {}),
          createdAt: at,
        }
        yield* addJob(job).pipe(Effect.provideService(FileSystem, fs))
        return { id: job.id, cron: job.cron }
      }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e))))

    // List this workspace's scheduled jobs (the same cron list :schedule reads).
    // Jobs are filtered to this workspace's cwd, then optionally to a folder.
    const list_scheduled_jobs = (params: { readonly folder?: string }) =>
      Effect.gen(function* () {
        const jobs = yield* loadJobs().pipe(Effect.provideService(FileSystem, fs))
        const folder =
          params.folder !== undefined && params.folder.length > 0 ? params.folder : undefined
        const mine = jobs.filter(
          (j) => j.cwd === binding.displayRoot && (folder === undefined || j.folder === folder),
        )
        return {
          jobs: mine.map((j) => ({
            id: j.id,
            cron: j.cron,
            task: j.prompt,
            folder: j.folder,
            ...(j.agent !== undefined ? { agent: j.agent } : {}),
            ...(j.lastRunMs !== undefined ? { lastRunMs: j.lastRunMs } : {}),
          })),
        }
      }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e))))

    // Cancel a scheduled job by id. `found:false` when no such job exists.
    const cancel_scheduled_job = (params: { readonly id: string }) =>
      Effect.gen(function* () {
        const found = yield* removeJob(params.id).pipe(Effect.provideService(FileSystem, fs))
        return { id: params.id, found }
      }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e))))

    // Declarative tools dispatcher: look up the named def, substitute escaped
    // args into its template, then execute (shell via Shell — gated by allowBash
    // + the Approval port; http via Http GET). Every failure is model-facing data.
    const toolDefs = new Map(opts.tools.map((t) => [t.name, t] as const))
    const run_tool = (params: { readonly name: string; readonly args?: string }) =>
      Effect.gen(function* () {
        const def = toolDefs.get(params.name)
        if (def === undefined) {
          return yield* Effect.fail({
            error: "UnknownTool",
            message: `no custom tool '${params.name}'. Available: ${[...toolDefs.keys()].join(", ") || "(none)"}.`,
          })
        }
        const parsedArgs = yield* parseToolArgs(params.args)
        if (parsedArgs === undefined) {
          return yield* Effect.fail({
            error: "InvalidArgs",
            message: 'args must be a JSON object of string values, e.g. {"path":"src"}',
          })
        }
        const escape = def.kind === "shell" ? shellEscape : encodeURIComponent
        const { filled, missing } = substituteTemplate(def.template, parsedArgs, escape)
        if (missing.length > 0) {
          return yield* Effect.fail({
            error: "MissingParams",
            message: `missing required params: ${missing.join(", ")}`,
          })
        }
        if (def.kind === "http") {
          const res = yield* http
            .get(filled, { maxBytes: 50_000 })
            .pipe(Effect.mapError((e) => ({ error: "HttpError", message: e.message })))
          return { output: clip(res.body, 16_000), exitCode: res.status }
        }
        if (!binding.allowBash) {
          return yield* Effect.fail({
            error: "BashDisabled",
            message: "custom shell tools need bash enabled (--allow-bash, or the TUI).",
          })
        }
        const decision = yield* approval.request({
          tool: "Bash",
          summary: filled,
          cwd: binding.rootDir,
          ruleKey: bashRuleKey(filled),
        })
        if (decision.kind === "deny") {
          return yield* Effect.fail({
            error: "Denied",
            message: decision.reason ?? "the command was denied",
          })
        }
        const res = yield* shell
          .exec({
            command: filled,
            cwd: binding.rootDir,
            ...(def.timeoutMs !== undefined ? { timeoutMs: def.timeoutMs } : {}),
          })
          .pipe(
            Effect.mapError((e) => ({
              error: e._tag,
              message:
                e._tag === "ShellError"
                  ? e.message
                  : e._tag === "ShellTimeout"
                    ? `timed out after ${e.timeoutMs}ms`
                    : `aborted: ${e.command}`,
            })),
          )
        const out = clip([res.stdout, res.stderr].filter((s) => s.length > 0).join("\n"), 16_000)
        return { output: out, ...(res.exitCode !== null ? { exitCode: res.exitCode } : {}) }
      }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e))))

    // The sender's label for comms: this fiber's own node (re-seeded as
    // `parentNodeId` for its children), else the lead agent (root conversation).
    const senderLabel = (rc: RunContext): string =>
      rc.parentNodeId !== null ? `agent ${String(rc.parentNodeId).slice(0, 8)}` : "the lead agent"

    const send_message = (params: { readonly to: string; readonly content: string }) =>
      Effect.gen(function* () {
        const rc = yield* FiberRef.get(RunContextRef)
        const at = yield* Clock.currentTimeMillis
        const delivered = yield* bus.post(params.to, {
          from: senderLabel(rc),
          content: params.content,
          at,
        })
        if (!delivered) {
          return yield* Effect.fail({
            error: "AgentNotRunning",
            message: `agent '${params.to}' is not running — it may have finished (its result is in :tree). Spawn or resume it instead of messaging.`,
          })
        }
        return { delivered: true }
      }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e))))

    const blackboard_post = (params: { readonly note: string }) =>
      Effect.gen(function* () {
        const rc = yield* FiberRef.get(RunContextRef)
        const at = yield* Clock.currentTimeMillis
        yield* bus.boardPost({ from: senderLabel(rc), note: params.note, at })
        return { posted: true }
      })

    const blackboard_read = (params: { readonly limit?: number }) =>
      Effect.gen(function* () {
        const all = yield* bus.boardRead()
        const picked =
          params.limit !== undefined && params.limit > 0 ? all.slice(-params.limit) : all
        return { notes: picked.map((n) => ({ from: n.from, note: n.note })) }
      })

    // The non-blocking gather: park (interruptibly) until a watched agent
    // finishes / someone messages me / the timeout, then report a full snapshot
    // + my drained inbox + the board. The waiter's bus key is its own node (the
    // key its children registered as `parentKey`), else the root conversation.
    const wait_for_agents = (params: {
      readonly nodeIds?: ReadonlyArray<string>
      readonly timeoutSeconds?: number
    }) =>
      Effect.gen(function* () {
        const rc = yield* FiberRef.get(RunContextRef)
        const waiterKey = rc.parentNodeId ?? rc.rootConversationId ?? "root"
        const requested = (params.nodeIds ?? [])
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        const watch =
          requested.length > 0 ? requested : yield* bus.childrenOf(waiterKey)
        // Default 10s, not 60: awaitChange wakes the instant a child finishes or
        // mail lands, so the timeout is only the idle floor — a 60s floor stranded
        // a polling orchestrator for a full minute when nothing had happened yet.
        const timeoutMs =
          Math.min(300, Math.max(1, Math.floor(params.timeoutSeconds ?? 10))) * 1000
        yield* bus.awaitChange({ waiterKey, watch, timeoutMs })
        const snaps = yield* bus.snapshot(watch.length > 0 ? watch : undefined)
        const inbox = yield* bus.drain(waiterKey)
        const board = yield* bus.boardRead()
        const allDone = snaps.length > 0 && snaps.every((s) => s.status !== "running")
        return {
          agents: snaps.map((s) => ({
            nodeId: s.nodeId,
            name: s.label,
            status: s.status,
            ...(s.summary !== undefined ? { summary: s.summary } : {}),
            ...(s.filesChanged !== undefined ? { filesChanged: s.filesChanged } : {}),
          })),
          messages: inbox.map((m) => ({ from: m.from, content: m.content })),
          notes: board.slice(-20).map((n) => ({ from: n.from, note: n.note })),
          timedOut: !allDone && inbox.length === 0,
          allDone,
        }
      })

    return {
      ...base,
      run_agent,
      send_message,
      blackboard_post,
      blackboard_read,
      wait_for_agents,
      run_tool,
      schedule,
      list_scheduled_jobs,
      cancel_scheduled_job,
    } as never
  })

/**
 * Turn the root `Scope` into a runnable `{ toolkit, handlerLayer }`. The toolkit
 * is static (base tools + `run_agent`); the handler layer binds the root scope
 * (write-unconfined workspace) and carries the `run_agent` handler that spawns
 * folder-scoped sub-agents on demand. `runAgent` seeds `RunContextRef` so the
 * first spawn is tagged with the conversation.
 */
export const buildScopeRuntime = <R = never>(
  scope: Scope,
  opts: BuildScopeRuntimeOptions,
  hooks?: AgentHooks<R>,
): ScopeRuntime => {
  const binding: ScopeBinding = {
    rootDir: scope.rootDir,
    displayRoot: scope.displayRoot,
    enforceWrite: scope.enforceWrite,
    allowBash: opts.allowBash ?? true,
  }
  // One comms bus per runtime: per-agent mailboxes + a shared blackboard, drawn
  // on by send_message / blackboard_* and drained into each agent's context.
  // The daemon's `onBusEvent` sink mirrors messages onto the event ledger.
  const bus = makeAgentBus(opts.onBusEvent)

  // When a fleet lead is in the roster the ROOT is a pure orchestrator: it gets
  // the orchestration-only toolkit (no work tools), so it CANNOT read/edit/grep
  // itself and must route work to a coordinator/research-coordinator. With no
  // fleet present the root keeps the full toolkit (the direct fast path for a
  // single-model, no-fleet setup). Sub-agents are unaffected — they build their
  // own per-spawn toolkit from `roleToolEntries`.
  const orchestrate = isOrchestrateMode(opts.agents)
  const rootHandlers = buildGenericHandlers(binding, opts, hooks, bus)
  const rootToolkit = orchestrate ? orchestrationToolkit : genericToolkit
  const handlerLayer = (
    orchestrate
      ? orchestrationToolkit.toLayer(
          rootHandlers.pipe(
            Effect.map(
              (full) =>
                Object.fromEntries(
                  Object.entries(full as Record<string, unknown>).filter(([k]) =>
                    ORCHESTRATION_TOOL_NAMES.has(k),
                  ),
                ) as never,
            ),
          ),
        )
      : genericToolkit.toLayer(rootHandlers)
  ) as ScopeRuntime["handlerLayer"]

  // The human-driven mirror of the handler's resume branch: same staleness
  // brief, same append-then-rerun, same persistence — minus the FiberRef (the
  // driver IS the root, so the resumed node runs at depth 0 with a fresh pool).
  const resumeNode: ScopeRuntime["resumeNode"] = ({ nodeId, task, budget, maxSteps, toolResultMaxChars }) =>
    Effect.gen(function* () {
      const store = yield* ContextTreeStore
      const shell = yield* Shell
      const node = yield* store.get(nodeId)
      const tokenPool = yield* makeTokenPool(budget ?? DEFAULT_SUB_AGENT_TOKEN_BUDGET)
      const brief = yield* buildStalenessBrief({
        workspaceDir: binding.displayRoot,
        nodeFolder: node.folder,
        stampedRef: node.workspaceRef,
      }).pipe(Effect.provideService(Shell, shell))
      const taskMsg = brief !== undefined ? `${brief}\n\n${task}` : task
      yield* store.append(nodeId, { role: "user", content: taskMsg })
      const seedMessages = yield* store.listMessages(nodeId)
      const rc = yield* FiberRef.get(RunContextRef)
      return yield* runSpawnedAgent({
        store,
        shell,
        bus,
        displayRoot: binding.displayRoot,
        opts,
        hooks,
        nodeId,
        folder: node.folder,
        task,
        seedMessages,
        ...(node.title !== undefined ? { title: node.title } : {}),
        parentDepth: 0,
        parentNodeId: node.parentId,
        rootConversationId: node.rootConversationId,
        tokenPool,
        runContext: rc,
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
      })
    }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))) as ReturnType<
      ScopeRuntime["resumeNode"]
    >

  // The human-driven mirror of the handler's FRESH-spawn branch: create a
  // top-level node under the active conversation, then run it at depth 0 with a
  // fresh pool. Resolves a role by name when `agent` is given (UnknownAgent if
  // it isn't loaded). Children it spawns hang off the node.
  const spawnAgent: ScopeRuntime["spawnAgent"] = ({
    rootConversationId,
    folder,
    task,
    title,
    agent,
    budget,
    maxSteps,
    toolResultMaxChars,
    mission,
    interactionPolicy,
  }) =>
    Effect.gen(function* () {
      const store = yield* ContextTreeStore
      const shell = yield* Shell
      const definition = yield* resolveAgent(opts.agents, agent)
      const folderAbs = resolve(binding.displayRoot, folder)
      const tokenPool = yield* makeTokenPool(budget ?? DEFAULT_SUB_AGENT_TOKEN_BUDGET)
      const cleanTitle =
        typeof title === "string" && title.trim().length > 0 ? title.trim() : undefined
      const cleanMission =
        typeof mission === "string" && mission.trim().length > 0 ? mission.trim() : undefined
      // The fresh spawn seeds the overall mission ahead of the task (if any), so a
      // scheduled run's leaf agents know the goal even when their brief is terse —
      // mirroring the model's `run_agent` fresh-spawn path (missionPreamble).
      const seedMessages: ReadonlyArray<AgentMessage> = [
        ...missionPreamble(cleanMission),
        { role: "user", content: task },
      ]
      const nodeId = yield* store.spawn({
        parentId: null,
        rootConversationId,
        edgeKind: "spawned",
        folder: folderAbs,
        displayRoot: binding.displayRoot,
        ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
        seed: { kind: "task", preview: clip(task, 80) },
        seedMessages,
      })
      const rc = yield* FiberRef.get(RunContextRef)
      // Seed the mission + interactionPolicy onto the run context `runSpawnedAgent`
      // copies down its subtree (childRc inherits both verbatim). The bare driver
      // RunContext never carried these, which is exactly why a scheduled run + its
      // fleet ran blind AND unattended-unaware — the job router fixes it here.
      const runContext: RunContext = {
        ...rc,
        ...(cleanMission !== undefined ? { mission: cleanMission } : {}),
        ...(interactionPolicy !== undefined ? { interactionPolicy } : {}),
      }
      return yield* runSpawnedAgent({
        store,
        shell,
        bus,
        displayRoot: binding.displayRoot,
        opts,
        hooks,
        nodeId,
        folder: folderAbs,
        task,
        seedMessages,
        ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
        ...(definition !== undefined ? { definition } : {}),
        parentDepth: 0,
        parentNodeId: null,
        rootConversationId,
        tokenPool,
        runContext,
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
      })
    }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))) as ReturnType<
      ScopeRuntime["spawnAgent"]
    >

  return { toolkit: rootToolkit, handlerLayer, resumeNode, spawnAgent, bus }
}
