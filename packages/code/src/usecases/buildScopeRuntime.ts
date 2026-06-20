import { basename, resolve } from "node:path"
import { LanguageModel, Tool, Toolkit } from "@effect/ai"
import { Clock, Effect, FiberRef, Layer, Ref, Schema } from "effect"
import {
  ContextNodeId,
  type ContextUsage,
  type AgentAfterToolCallEvent,
  type AgentHooks,
  type AgentMessage,
  type Prompt,
  type Scope,
  Approval,
  bashRuleKey,
  ContextTreeStore,
  FileSystem,
  Http,
  Shell,
  WebSearch,
  agentSpanAttributes,
  subagentSpanName,
  runAgentLoop,
  generateHandoffBrief,
  handoffToMessage,
  RunContextRef,
  BUDGET_STOP_NOTE,
  budgetExhaustedFailure,
  DEFAULT_SUB_AGENT_TOKEN_BUDGET,
  drainPool,
  makeTokenPool,
  poolExhausted,
  type TokenPool,
  Failure,
  toFailure,
  type Skill,
  type AgentDefinition,
  ConversationId,
  type RunContext,
} from "@xandreed/sdk-core"
import { renderScopeSystemPrompt } from "../prompts/coder.js"
import {
  codingToolkit,
  makeCodingHandlers,
  type ScopeBinding,
} from "./codingToolkit.js"
import { getScopePromptBody } from "./discoverScopeTree.js"
import { makeFolderLocks, withFolderLock, type FolderLocks } from "./folderLock.js"
import { type AgentBus, inboxToMessages, makeAgentBus } from "./agentBus.js"
import { type ToolDefinition, shellEscape, substituteTemplate } from "./loadTools.js"
import { addJob, parseCron, type ScheduledJob } from "./schedule.js"
import { buildStalenessBrief, getWorkspaceRef } from "./staleness.js"

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
    FileSystem | Shell | Http | WebSearch | ContextTreeStore | Approval
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

/** Default step (turn) cap per spawned sub-agent — overridable via
 *  `Settings.subAgentMaxSteps` (threaded through `RunContext`) or
 *  `BuildScopeRuntimeOptions.maxSteps`. */
export const DEFAULT_SUB_AGENT_MAX_STEPS = 80

/** Appended to a sub-agent's summary when the step cap cut it off mid-work —
 *  without it the run's mid-thought last sentence reads as the deliverable. */
export const STEP_STOP_NOTE =
  "[stopped early: the step limit was reached — this result is partial]"

export interface BuildScopeRuntimeOptions {
  readonly skills: ReadonlyArray<Skill>
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
  /** Step budget for each (nested) sub-agent loop. Default 80. */
  readonly maxSteps?: number
  /** Max spawn nesting depth; beyond it `run_agent` returns a failure. Default 2. */
  readonly maxDepth?: number
  /** Allow the `bash` tool. Default true. */
  readonly allowBash?: boolean
}

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}…`

/** Parse a `run_tool` args JSON-object string into string-valued params. `{}` for
 *  empty/absent; undefined when it isn't a JSON object (a validation failure). */
const parseToolArgs = (raw: string | undefined): Record<string, string> | undefined => {
  if (raw === undefined || raw.trim().length === 0) return {}
  try {
    const v = JSON.parse(raw) as unknown
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v)) out[k] = typeof val === "string" ? val : String(val)
    return out
  } catch {
    return undefined
  }
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
    "returns { summary, filesChanged, nodeId }. Prefer it when a change is localized to one " +
    "area; it keeps your own context focused. Be explicit in 'task' — the sub-agent starts " +
    "fresh unless you resume/branch a node. DEFAULT TO A FRESH SPAWN: one agent = one piece " +
    "of work; a new task gets a new agent even in the same folder (fresh context is cheaper " +
    "and more focused — a resume re-feeds the node's entire history every turn). Reuse a node " +
    "only when the new task is a direct follow-up on that node's OWN work: seedMode 'resume' " +
    "to continue/fix/extend what it just did (its accumulated file knowledge pays for itself), " +
    "'branch' to retry or take an alternative direction from its context without growing it.",
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
        "The focused task: what to change and any constraints. The sub-agent has no prior context unless seeded — be explicit.",
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
        "as — it sets the sub-agent's system-prompt instructions, its model, and its tool allowlist. " +
        "Omit for a generic folder-scoped coder. Use a role when the task fits a specialty (e.g. " +
        "'reviewer', 'security-auditor', 'docs-writer').",
    }),
  },
  success: Schema.Struct({
    summary: Schema.String,
    filesChanged: Schema.Array(Schema.String),
    // The spawned node's id — a real `ContextNodeId`, so the tool's output
    // schema encodes/validates it as a branded UUID (the model later feeds it
    // back as `seedFromNode`, which is decoded at that boundary).
    nodeId: ContextNodeId,
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

/** `[name, def]` entries for the comms + run_tool + schedule tools — for the toolkit + role allowlists. */
const commsToolEntries: ReadonlyArray<readonly [string, Tool.Any]> = [
  ["send_message", SendMessageTool],
  ["blackboard_post", BlackboardPostTool],
  ["blackboard_read", BlackboardReadTool],
  ["run_tool", RunToolTool],
  ["schedule", ScheduleTool],
]

/** The toolkit is static: base coding tools + comms/run_tool + the `run_agent` tool.
 *  (Declarative tools are dispatched through the single `run_tool`, so the
 *  toolkit shape doesn't vary with which tool files are present.) */
const genericToolkit = Toolkit.make(
  ...([
    ...baseToolDefs,
    ...commsToolEntries.map(([, d]) => d),
    RunAgentTool,
  ] as ReadonlyArray<Tool.Any>),
) as unknown as Toolkit.Toolkit<Record<string, Tool.Any>>

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
  filesRef: Ref.Ref<ReadonlyArray<string>>,
  usageRef: Ref.Ref<ContextUsage>,
  pool: TokenPool,
  budgetStopRef: Ref.Ref<boolean>,
  bus: AgentBus,
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
    ...(parentBefore !== undefined
      ? {
          onBeforeToolCall: (e: Parameters<typeof parentBefore>[0]) =>
            parentBefore({ ...e, subAgentNodeId: nodeId }),
        }
      : {}),
    onAfterToolCall: (e) =>
      parentAfter !== undefined
        ? Effect.gen(function* () {
            yield* parentAfter({ ...e, subAgentNodeId: nodeId })
            yield* trackFiles(e)
          })
        : trackFiles(e),
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
      // Forward inner narration to the parent's event stream too — the TUI
      // shows it live when this node's session is open in the preview (the
      // pump keeps it off the parent rail; usage stays node-local).
      return parentAssistant !== undefined
        ? parentAssistant({ ...event, subAgentNodeId: nodeId }).pipe(Effect.zipRight(track))
        : track
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
  readonly locks: FolderLocks
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
const runSpawnedAgent = <R>(args: RunSpawnedArgs<R>) =>
  withFolderLock(args.locks, args.folder)(Effect.gen(function* () {
    const { store, displayRoot, opts, hooks, nodeId, folder, task, seedMessages } = args
    const definition = args.definition
    const label = args.title ?? (basename(folder) || folder)
    const filesRef = yield* Ref.make<ReadonlyArray<string>>([])
    const usageRef = yield* Ref.make<ContextUsage>({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    })

    if (hooks?.onSubAgentStart) {
      yield* hooks.onSubAgentStart({
        name: label,
        task,
        nodeId,
        ...(args.parentNodeId !== null ? { parentNodeId: args.parentNodeId } : {}),
      })
    }
    // Register a live mailbox so siblings/the human can message this run; torn
    // down on every exit path (success, failure, interrupt) by the ensuring below.
    yield* args.bus.markRunning(nodeId, label)
    const budgetStopRef = yield* Ref.make(false)
    const innerHooks = makeInnerHooks(
      hooks,
      nodeId,
      filesRef,
      usageRef,
      args.tokenPool,
      budgetStopRef,
      args.bus,
    )

    const binding: ScopeBinding = {
      rootDir: folder,
      displayRoot,
      enforceWrite: true,
      allowBash: opts.allowBash ?? true,
    }
    const scopeBody = yield* getScopePromptBody(folder)
    // Role instructions (if any) lead, then the folder's ambient SCOPE.md body —
    // both land in renderScopeSystemPrompt's instructions slot, so the scope /
    // write-confinement / return-contract scaffold always wraps them.
    const combinedBody = [definition?.body, scopeBody]
      .filter((b): b is string => typeof b === "string" && b.trim().length > 0)
      .join("\n\n")
    const system = renderScopeSystemPrompt({
      name: label,
      rootDir: folder,
      displayRoot,
      body: combinedBody,
      now: new Date(),
      // Give a coordinator (a role with run_agent) the roster so it can name its
      // specialists; leaf workers ignore it.
      agents: opts.agents,
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
    const handlers = buildGenericHandlers(binding, opts, hooks, args.locks, args.bus)
    const roleEntries = definition !== undefined ? roleToolEntries(definition) : undefined
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
      ...(args.toolResultMaxChars !== undefined
        ? { toolResultMaxChars: args.toolResultMaxChars }
        : {}),
      // Inherit the root agent's compression policy (the loop reads it off
      // RunContext when no per-call override is given).
      ...(args.runContext.compression !== undefined
        ? { compression: args.runContext.compression }
        : {}),
      // A role that pins a model overrides the main tier for THIS run only
      // (read by the router off RunContextRef). NOT inherited by nested generic
      // spawns — they re-seed their own childRc without it.
      ...(definition?.model !== undefined ? { modelOverride: definition.model } : {}),
    }

    const outcome = yield* runAgentLoop({
      system,
      messages: seedMessages,
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
      for (const m of outcome.r.newTail) yield* store.append(nodeId, m)
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
  })).pipe(Effect.ensuring(args.bus.markDone(args.nodeId)))

/** The `run_agent` handler: spawn / resume / branch a folder-scoped sub-agent. */
const makeRunAgentHandler =
  <R>(
    store: ContextTreeStore["Type"],
    shell: Shell["Type"],
    locks: FolderLocks,
    bus: AgentBus,
    displayRoot: string,
    opts: BuildScopeRuntimeOptions,
    hooks: AgentHooks<R> | undefined,
  ) =>
  (params: {
    readonly name: string
    readonly folder: string
    readonly task: string
    readonly seedFromNode?: string
    readonly seedMode?: "resume" | "branch" | "handoff"
    readonly agent?: string
  }) =>
    Effect.gen(function* () {
      const rc = yield* FiberRef.get(RunContextRef)
      const maxDepth = opts.maxDepth ?? 2
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
      const { name, folder, task, seedFromNode, seedMode, agent } = params
      // The model-given display name; blank/absent (a stale provider replaying
      // an old-schema call) degrades to the folder basename.
      const title =
        typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined

      // Resolve the requested role (if any). A named-but-unknown agent is a
      // model-facing failure — silently ignoring a requested role hides a real
      // mistake (mirrors read_skill's UnknownSkill). Absent ⇒ generic spawn.
      const definition = yield* resolveAgent(opts.agents, agent)

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
          return yield* runSpawnedAgent({
            store, shell, locks, bus, displayRoot, opts, hooks, nodeId, folder: node.folder, task, seedMessages,
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
                handoffToMessage(yield* generateHandoffBrief(sourceMsgs)),
                { role: "user", content: taskMsg },
              ]
            : [...sourceMsgs, { role: "user", content: taskMsg }]
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
        return yield* runSpawnedAgent({
          store, shell, locks, bus, displayRoot, opts, hooks, nodeId: childId, folder: node.folder, task, seedMessages,
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

      // Fresh spawn.
      const folderAbs = resolve(displayRoot, folder)
      const seedMessages: ReadonlyArray<AgentMessage> = [{ role: "user", content: task }]
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
      return yield* runSpawnedAgent({
        store, shell, locks, bus, displayRoot, opts, hooks, nodeId, folder: folderAbs, task, seedMessages,
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
  locks: FolderLocks,
  bus: AgentBus,
) =>
  Effect.gen(function* () {
    const base = yield* makeCodingHandlers(binding, opts.skills)
    const store = yield* ContextTreeStore
    const shell = yield* Shell
    const http = yield* Http
    const fs = yield* FileSystem
    const approval = yield* Approval
    const run_agent = makeRunAgentHandler(store, shell, locks, bus, binding.displayRoot, opts, hooks)

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
        const parsedArgs = parseToolArgs(params.args)
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

    return {
      ...base,
      run_agent,
      send_message,
      blackboard_post,
      blackboard_read,
      run_tool,
      schedule,
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
  // One locks map per runtime: parallel spawns into the SAME folder serialize
  // even across subtrees (cousins included); disjoint folders fan out freely.
  const locks = makeFolderLocks()
  // One comms bus per runtime: per-agent mailboxes + a shared blackboard, drawn
  // on by send_message / blackboard_* and drained into each agent's context.
  const bus = makeAgentBus()
  const handlerLayer = genericToolkit.toLayer(
    buildGenericHandlers(binding, opts, hooks, locks, bus),
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
        locks,
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
  }) =>
    Effect.gen(function* () {
      const store = yield* ContextTreeStore
      const shell = yield* Shell
      const definition = yield* resolveAgent(opts.agents, agent)
      const folderAbs = resolve(binding.displayRoot, folder)
      const tokenPool = yield* makeTokenPool(budget ?? DEFAULT_SUB_AGENT_TOKEN_BUDGET)
      const cleanTitle =
        typeof title === "string" && title.trim().length > 0 ? title.trim() : undefined
      const seedMessages: ReadonlyArray<AgentMessage> = [{ role: "user", content: task }]
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
      return yield* runSpawnedAgent({
        store,
        shell,
        locks,
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
        runContext: rc,
        ...(maxSteps !== undefined ? { maxSteps } : {}),
        ...(toolResultMaxChars !== undefined ? { toolResultMaxChars } : {}),
      })
    }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))) as ReturnType<
      ScopeRuntime["spawnAgent"]
    >

  return { toolkit: genericToolkit, handlerLayer, resumeNode, spawnAgent, bus }
}
