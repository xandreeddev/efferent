import { basename, resolve } from "node:path"
import { Tool, Toolkit } from "@effect/ai"
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
import { RunContextRef } from "./runContext.js"
import {
  BUDGET_STOP_NOTE,
  budgetExhaustedFailure,
  drainPool,
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
    FileSystem | Shell | Http | WebSearch | ContextTreeStore
  >
}

export interface BuildScopeRuntimeOptions {
  readonly skills: ReadonlyArray<import("../entities/Skill.js").Skill>
  /** Step budget for each (nested) sub-agent loop. Default 12. */
  readonly maxSteps?: number
  /** Max spawn nesting depth; beyond it `run_agent` returns a failure. Default 6. */
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
    "fresh unless you resume/branch a node. To continue prior work, pass seedFromNode with " +
    "seedMode: 'resume' (keep working in that node) or 'branch' (a new node from its context).",
  parameters: {
    folder: Schema.String.annotations({
      description:
        "Folder to scope the sub-agent to, relative to the workspace root (e.g. 'packages/adapters').",
    }),
    task: Schema.String.annotations({
      description:
        "The focused task: what to change and any constraints. The sub-agent has no prior context unless seeded — be explicit.",
    }),
    seedFromNode: Schema.optional(Schema.String).annotations({
      description: "An existing context-node id to resume or branch from (from a prior run_agent result).",
    }),
    seedMode: Schema.optional(Schema.Literal("resume", "branch")).annotations({
      description: "With seedFromNode: 'resume' continues that node; 'branch' starts a new node seeded from it. Defaults to 'branch'.",
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

  const parentAfter = parent?.onAfterToolCall
  return {
    ...(parent?.onBeforeToolCall !== undefined
      ? { onBeforeToolCall: parent.onBeforeToolCall }
      : {}),
    onAfterToolCall:
      parentAfter !== undefined
        ? (e) =>
            Effect.gen(function* () {
              yield* parentAfter(e)
              yield* trackFiles(e)
            })
        : trackFiles,
    onAssistantMessage: (event) => {
      const u = event.usage
      return u !== undefined
        ? Ref.update(usageRef, (acc) => ({
            inputTokens: u.inputTokens,
            outputTokens: acc.outputTokens + u.outputTokens,
            cacheReadTokens: u.cacheReadTokens,
          })).pipe(Effect.zipRight(drainPool(pool, u)))
        : Effect.void
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
  readonly displayRoot: string
  readonly opts: BuildScopeRuntimeOptions
  readonly hooks: AgentHooks<R> | undefined
  readonly nodeId: ContextNodeId
  readonly folder: string
  readonly task: string
  readonly seedMessages: ReadonlyArray<AgentMessage>
  readonly parentDepth: number
  readonly rootConversationId: import("../entities/Conversation.js").ConversationId | null
  readonly tokenPool: TokenPool
}

/**
 * Run a spawned sub-agent over its already-created node: render the scoped
 * system prompt (+ ambient `SCOPE.md` body), run the loop with the generic
 * toolkit under the folder's `ScopeBinding`, persist the produced tail to the
 * node, record the return, and emit the sub-agent start/end events (carrying the
 * node id). Re-seeds `RunContextRef` so nested `run_agent` calls see this node
 * as their parent.
 */
const runSpawnedAgent = <R>(args: RunSpawnedArgs<R>) =>
  Effect.gen(function* () {
    const { store, displayRoot, opts, hooks, nodeId, folder, task, seedMessages } = args
    const label = basename(folder) || folder
    const filesRef = yield* Ref.make<ReadonlyArray<string>>([])
    const usageRef = yield* Ref.make<ContextUsage>({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    })

    if (hooks?.onSubAgentStart) {
      yield* hooks.onSubAgentStart({ name: label, task, nodeId })
    }
    const budgetStopRef = yield* Ref.make(false)
    const innerHooks = makeInnerHooks(hooks, filesRef, usageRef, args.tokenPool, budgetStopRef)

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

    const childLayer = genericToolkit.toLayer(buildGenericHandlers(binding, opts, hooks))
    const childRc = {
      rootConversationId: args.rootConversationId,
      parentNodeId: nodeId,
      depth: args.parentDepth + 1,
      tokenPool: args.tokenPool,
    }

    const outcome = yield* runAgentLoop({
      system,
      messages: seedMessages,
      toolkit: genericToolkit,
      maxSteps: opts.maxSteps ?? 12,
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

    if (outcome.ok) {
      const tail = outcome.r.messages.slice(seedMessages.length)
      for (const m of tail) yield* store.append(nodeId, m)
      // A budget stop is an *ok* outcome with a partial result — say so, so
      // the parent model (and the human in :tree) knows not to trust it as
      // complete, instead of silently presenting half the work as done.
      const stoppedByBudget = yield* Ref.get(budgetStopRef)
      const summary = stoppedByBudget
        ? `${outcome.r.finalText}\n\n${BUDGET_STOP_NOTE}`.trim()
        : outcome.r.finalText
      yield* store.recordReturn(nodeId, {
        status: "ok",
        summary,
        filesChanged: files,
        ...(hasUsage ? { usage } : {}),
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
  })

/** The `run_agent` handler: spawn / resume / branch a folder-scoped sub-agent. */
const makeRunAgentHandler =
  <R>(
    store: ContextTreeStore["Type"],
    displayRoot: string,
    opts: BuildScopeRuntimeOptions,
    hooks: AgentHooks<R> | undefined,
  ) =>
  (params: {
    readonly folder: string
    readonly task: string
    readonly seedFromNode?: string
    readonly seedMode?: "resume" | "branch"
  }) =>
    Effect.gen(function* () {
      const rc = yield* FiberRef.get(RunContextRef)
      const maxDepth = opts.maxDepth ?? 6
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
      const { folder, task, seedFromNode, seedMode } = params

      // Resume / branch an existing node.
      if (seedFromNode !== undefined && seedFromNode.trim().length > 0) {
        const nodeId = yield* Schema.decodeUnknown(ContextNodeId)(seedFromNode.trim()).pipe(
          Effect.mapError(() => ({
            error: "InvalidNodeId",
            message: `'${seedFromNode}' is not a valid context-node id.`,
          })),
        )
        const node = yield* store.get(nodeId)
        if (seedMode === "resume") {
          yield* store.append(nodeId, { role: "user", content: task })
          const seedMessages = yield* store.listMessages(nodeId)
          return yield* runSpawnedAgent({
            store, displayRoot, opts, hooks, nodeId, folder: node.folder, task, seedMessages,
            parentDepth: rc.depth, rootConversationId: rc.rootConversationId,
            tokenPool: rc.tokenPool,
          })
        }
        const sourceMsgs = yield* store.listMessages(nodeId)
        const seedMessages: ReadonlyArray<AgentMessage> = [
          ...sourceMsgs,
          { role: "user", content: task },
        ]
        const childId = yield* store.spawn({
          parentId: nodeId,
          rootConversationId: rc.rootConversationId,
          edgeKind: "branched",
          folder: node.folder,
          displayRoot,
          seed: { kind: "selection", sourceNodeId: nodeId, turnCount: sourceMsgs.length },
          seedMessages,
        })
        return yield* runSpawnedAgent({
          store, displayRoot, opts, hooks, nodeId: childId, folder: node.folder, task, seedMessages,
          parentDepth: rc.depth, rootConversationId: rc.rootConversationId,
          tokenPool: rc.tokenPool,
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
        seed: { kind: "task", preview: clip(task, 80) },
        seedMessages,
      })
      return yield* runSpawnedAgent({
        store, displayRoot, opts, hooks, nodeId, folder: folderAbs, task, seedMessages,
        parentDepth: rc.depth, rootConversationId: rc.rootConversationId,
        tokenPool: rc.tokenPool,
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
) =>
  Effect.gen(function* () {
    const base = yield* makeCodingHandlers(binding, opts.skills)
    const store = yield* ContextTreeStore
    const run_agent = makeRunAgentHandler(store, binding.displayRoot, opts, hooks)
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
  const handlerLayer = genericToolkit.toLayer(
    buildGenericHandlers(binding, opts, hooks),
  ) as ScopeRuntime["handlerLayer"]
  return { toolkit: genericToolkit, handlerLayer }
}
