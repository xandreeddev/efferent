import { basename, resolve } from "node:path"
import { LanguageModel, Tool, Toolkit } from "@effect/ai"
import { Effect, FiberRef, Layer, Ref, Schema } from "effect"
import {
  ContextNodeId,
  type ContextUsage,
} from "../entities/AgentContext.js"
import type {
  AgentAfterToolCallEvent,
  AgentHooks,
} from "../entities/AgentHooks.js"
import type { AgentMessage } from "../entities/Conversation.js"
import type { Scope } from "../entities/Scope.js"
import { renderScopeSystemPrompt } from "../prompts/coder.js"
import type { Approval } from "../ports/Approval.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Http } from "../ports/Http.js"
import { Shell } from "../ports/Shell.js"
import { WebSearch } from "../ports/WebSearch.js"
import { runAgentLoop } from "./agentLoop.js"
import {
  codingToolkit,
  Failure,
  makeCodingHandlers,
  type ScopeBinding,
  toFailure,
} from "./codingToolkit.js"
import { getScopePromptBody } from "./discoverScopeTree.js"
import { makeFolderLocks, withFolderLock, type FolderLocks } from "./folderLock.js"
import { generateHandoffBrief } from "./handoff.js"
import { handoffToMessage } from "./promptMapping.js"
import { RunContextRef } from "./runContext.js"
import { buildStalenessBrief, getWorkspaceRef } from "./staleness.js"
import {
  BUDGET_STOP_NOTE,
  budgetExhaustedFailure,
  DEFAULT_SUB_AGENT_TOKEN_BUDGET,
  drainPool,
  makeTokenPool,
  poolExhausted,
  type TokenPool,
} from "./tokenBudget.js"

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
  }) => Effect.Effect<
    { summary: string; filesChanged: ReadonlyArray<string>; nodeId: string },
    Failure,
    | FileSystem
    | Shell
    | Http
    | WebSearch
    | ContextTreeStore
    | Approval
    | LanguageModel.LanguageModel
  >
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
  readonly skills: ReadonlyArray<import("../entities/Skill.js").Skill>
  /** Step budget for each (nested) sub-agent loop. Default 80. */
  readonly maxSteps?: number
  /** Max spawn nesting depth; beyond it `run_agent` returns a failure. Default 2. */
  readonly maxDepth?: number
  /** Allow the `bash` tool. Default true. */
  readonly allowBash?: boolean
}

const clip = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n)}…`

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
  },
  success: Schema.Struct({
    summary: Schema.String,
    filesChanged: Schema.Array(Schema.String),
    nodeId: Schema.String,
  }),
  failure: Failure,
  failureMode: "return",
})

/** The toolkit is static now: base tools + the one `run_agent` tool. */
const genericToolkit = Toolkit.make(
  ...([...baseToolDefs, RunAgentTool] as ReadonlyArray<Tool.Any>),
) as unknown as Toolkit.Toolkit<Record<string, Tool.Any>>

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
  nodeId: string,
  filesRef: Ref.Ref<ReadonlyArray<string>>,
  usageRef: Ref.Ref<ContextUsage>,
  pool: TokenPool,
  budgetStopRef: Ref.Ref<boolean>,
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
    ...(parent?.onSubAgentStart !== undefined
      ? { onSubAgentStart: parent.onSubAgentStart }
      : {}),
    ...(parent?.onSubAgentEnd !== undefined
      ? { onSubAgentEnd: parent.onSubAgentEnd }
      : {}),
    ...(parent?.onSkillLoad !== undefined
      ? { onSkillLoad: parent.onSkillLoad }
      : {}),
  }
}

interface RunSpawnedArgs<R> {
  readonly store: ContextTreeStore["Type"]
  readonly shell: Shell["Type"]
  readonly locks: FolderLocks
  readonly displayRoot: string
  readonly opts: BuildScopeRuntimeOptions
  readonly hooks: AgentHooks<R> | undefined
  readonly nodeId: ContextNodeId
  readonly folder: string
  readonly task: string
  /** Display name from the spawner — the label every event/UI surface uses. */
  readonly title?: string
  readonly seedMessages: ReadonlyArray<AgentMessage>
  readonly parentDepth: number
  /** The node's parent in the context tree (for consumer-side nesting). */
  readonly parentNodeId: string | null
  readonly rootConversationId: import("../entities/Conversation.js").ConversationId | null
  readonly tokenPool: TokenPool
  /** Live per-run step cap (`Settings.subAgentMaxSteps` via `RunContext`). */
  readonly maxSteps?: number
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
    const budgetStopRef = yield* Ref.make(false)
    const innerHooks = makeInnerHooks(hooks, nodeId, filesRef, usageRef, args.tokenPool, budgetStopRef)

    const binding: ScopeBinding = {
      rootDir: folder,
      displayRoot,
      enforceWrite: true,
      allowBash: opts.allowBash ?? true,
    }
    const body = yield* getScopePromptBody(folder)
    const system = renderScopeSystemPrompt({
      name: label,
      rootDir: folder,
      displayRoot,
      body: body ?? "",
      now: new Date(),
    })

    const childLayer = genericToolkit.toLayer(
      buildGenericHandlers(binding, opts, hooks, args.locks),
    )
    const childRc = {
      rootConversationId: args.rootConversationId,
      parentNodeId: nodeId,
      depth: args.parentDepth + 1,
      tokenPool: args.tokenPool,
      ...(args.maxSteps !== undefined ? { subAgentMaxSteps: args.maxSteps } : {}),
    }

    const outcome = yield* runAgentLoop({
      system,
      messages: seedMessages,
      toolkit: genericToolkit,
      maxSteps: args.maxSteps ?? opts.maxSteps ?? DEFAULT_SUB_AGENT_MAX_STEPS,
      hooks: innerHooks,
    }).pipe(
      Effect.provide(childLayer),
      Effect.locally(RunContextRef, childRc),
      Effect.map((r) => ({ ok: true as const, r })),
      Effect.catchAll((e) => Effect.succeed({ ok: false as const, e })),
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
  }))

/** The `run_agent` handler: spawn / resume / branch a folder-scoped sub-agent. */
const makeRunAgentHandler =
  <R>(
    store: ContextTreeStore["Type"],
    shell: Shell["Type"],
    locks: FolderLocks,
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
      const { name, folder, task, seedFromNode, seedMode } = params
      // The model-given display name; blank/absent (a stale provider replaying
      // an old-schema call) degrades to the folder basename.
      const title =
        typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined

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
            store, shell, locks, displayRoot, opts, hooks, nodeId, folder: node.folder, task, seedMessages,
            // The fresh name describes the follow-up; the node keeps its own.
            ...(title !== undefined ? { title } : node.title !== undefined ? { title: node.title } : {}),
            parentDepth: rc.depth, parentNodeId: node.parentId,
            rootConversationId: rc.rootConversationId,
            tokenPool: rc.tokenPool,
            ...(rc.subAgentMaxSteps !== undefined ? { maxSteps: rc.subAgentMaxSteps } : {}),
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
          store, shell, locks, displayRoot, opts, hooks, nodeId: childId, folder: node.folder, task, seedMessages,
          ...(title !== undefined ? { title } : {}),
          parentDepth: rc.depth, parentNodeId: nodeId,
          rootConversationId: rc.rootConversationId,
          tokenPool: rc.tokenPool,
          ...(rc.subAgentMaxSteps !== undefined ? { maxSteps: rc.subAgentMaxSteps } : {}),
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
        store, shell, locks, displayRoot, opts, hooks, nodeId, folder: folderAbs, task, seedMessages,
        ...(title !== undefined ? { title } : {}),
        parentDepth: rc.depth, parentNodeId: rc.parentNodeId,
        rootConversationId: rc.rootConversationId,
        tokenPool: rc.tokenPool,
        ...(rc.subAgentMaxSteps !== undefined ? { maxSteps: rc.subAgentMaxSteps } : {}),
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
) =>
  Effect.gen(function* () {
    const base = yield* makeCodingHandlers(binding, opts.skills)
    const store = yield* ContextTreeStore
    const shell = yield* Shell
    const run_agent = makeRunAgentHandler(store, shell, locks, binding.displayRoot, opts, hooks)
    return { ...base, run_agent } as never
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
  const handlerLayer = genericToolkit.toLayer(
    buildGenericHandlers(binding, opts, hooks, locks),
  ) as ScopeRuntime["handlerLayer"]

  // The human-driven mirror of the handler's resume branch: same staleness
  // brief, same append-then-rerun, same persistence — minus the FiberRef (the
  // driver IS the root, so the resumed node runs at depth 0 with a fresh pool).
  const resumeNode: ScopeRuntime["resumeNode"] = ({ nodeId, task, budget, maxSteps }) =>
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
      return yield* runSpawnedAgent({
        store,
        shell,
        locks,
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
        ...(maxSteps !== undefined ? { maxSteps } : {}),
      })
    }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e)))) as ReturnType<
      ScopeRuntime["resumeNode"]
    >

  return { toolkit: genericToolkit, handlerLayer, resumeNode }
}
