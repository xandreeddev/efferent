import { relative } from "node:path"
import { Tool, Toolkit } from "@effect/ai"
import { Effect, Layer, Ref, Schema } from "effect"
import type {
  AgentAfterToolCallEvent,
  AgentHooks,
} from "../entities/AgentHooks.js"
import type { AgentMessage } from "../entities/Conversation.js"
import type { Scope } from "../entities/Scope.js"
import type { Skill } from "../entities/Skill.js"
import { FileSystem } from "../ports/FileSystem.js"
import { Http } from "../ports/Http.js"
import { Shell } from "../ports/Shell.js"
import { WebSearch } from "../ports/WebSearch.js"
import { runAgentLoop } from "./agentLoop.js"
import {
  codingToolkit,
  Failure,
  makeCodingHandlers,
  toFailure,
} from "./codingToolkit.js"

/**
 * A runnable scope: the per-scope `@effect/ai` Toolkit (the base coding
 * tools + a `delegate_to_<child>` tool per direct child) and its handler
 * `Layer`. Provided to a `runAgentLoop` call to make a scope executable.
 *
 * The dynamic toolkit can't be precisely typed (its tool set is built at
 * runtime), so we erase to `Record<string, Tool.Any>`. `runAgentLoop` is
 * generic over exactly that, and `failureMode: "return"` makes results
 * model-facing data — so the erasure costs nothing at the call site.
 */
export interface ScopeRuntime {
  readonly toolkit: Toolkit.Toolkit<Record<string, Tool.Any>>
  readonly handlerLayer: Layer.Layer<
    Tool.HandlersFor<Record<string, Tool.Any>>,
    never,
    FileSystem | Shell | Http | WebSearch
  >
}

export interface BuildScopeRuntimeOptions {
  readonly skills: ReadonlyArray<Skill>
  /** Step budget for each (nested) sub-agent loop. Default 12. */
  readonly maxSteps?: number
  /** Max delegation depth; beyond it a scope is built as a leaf. Default 6. */
  readonly maxDepth?: number
  /** Allow the `bash` tool across the whole scope tree. Default true. */
  readonly allowBash?: boolean
}

/** Base coding tool definitions (read/write/edit/bash/grep/glob/ls/read_skill/web_fetch). */
const baseToolDefs = Object.values(codingToolkit.tools) as ReadonlyArray<Tool.Any>

const delegateName = (scope: Scope): string => `delegate_to_${scope.name}`

const makeDelegateTool = (displayRoot: string, child: Scope) =>
  Tool.make(delegateName(child), {
    description:
      `Delegate a focused task to the '${child.name}' sub-agent. ${child.description} ` +
      `It runs in a fresh context window — it sees only the task you pass plus its own scope instructions. ` +
      `It reads anywhere but writes/runs bash only inside ${relative(displayRoot, child.rootDir) || "."}. ` +
      `Returns { summary, filesChanged }.`,
    parameters: {
      task: Schema.String.annotations({
        description:
          "The focused task: what to change and any constraints. The sub-agent has no prior context — be explicit.",
      }),
    },
    success: Schema.Struct({
      summary: Schema.String,
      filesChanged: Schema.Array(Schema.String),
    }),
    failure: Failure,
    failureMode: "return",
  })

/**
 * Inner hooks for a nested sub-agent loop. Forwards the parent's tool-call
 * + sub-agent + skill events (so the TUI side-pane shows nested activity),
 * chains a file-tracker onto `onAfterToolCall` (write/edit successes feed
 * the delegation's `filesChanged`), and — deliberately — does NOT forward
 * `onTurnStart`/`onAssistantMessage`/`onAgentEnd`: those belong to the
 * outer loop, and forwarding `onAgentEnd` would prematurely end the turn.
 */
const makeInnerHooks = <R>(
  parent: AgentHooks<R> | undefined,
  filesRef: Ref.Ref<ReadonlyArray<string>>,
  usageRef: Ref.Ref<{ inputTokens: number; outputTokens: number; cacheReadTokens: number }>,
): AgentHooks<R> => {
  const trackFiles = (event: AgentAfterToolCallEvent) =>
    Effect.gen(function* () {
      if (!event.ok) return
      if (event.toolName !== "write_file" && event.toolName !== "edit_file") {
        return
      }
      const path = (event.result as { path?: unknown })?.path
      if (typeof path !== "string") return
      yield* Ref.update(filesRef, (arr) =>
        arr.includes(path) ? arr : [...arr, path],
      )
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
          }))
        : Effect.void
    },
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

/**
 * Turn a `Scope` into a runnable `{ toolkit, handlerLayer }`.
 *
 * The toolkit is the base coding tools (scope-confined writes/bash via
 * `makeCodingHandlers`) plus one `delegate_to_<child>` tool per direct
 * child. A delegate handler runs the child's loop **ephemerally**
 * (`runAgentLoop`, no persistence) with the child's own runtime —
 * recursively built one level deeper — self-providing the child's handler
 * layer. `LanguageModel`/`FileSystem`/`Shell`/`Http` are resolved from the
 * context the layer is built in (the composition root), which `@effect/ai`
 * merges into every handler invocation — so the nested loop is fully
 * satisfied without explicit threading.
 *
 * Recursion is lazy (per delegation call) so file-tracking hooks chain
 * correctly down the tree; it terminates at leaves (and is capped at
 * `maxDepth` as a backstop — the scope tree is acyclic by construction).
 */
export const buildScopeRuntime = <R = never>(
  scope: Scope,
  opts: BuildScopeRuntimeOptions,
  hooks?: AgentHooks<R>,
  depth = 0,
): ScopeRuntime => {
  const maxDepth = opts.maxDepth ?? 6
  const children = depth < maxDepth ? scope.children : []

  const toolDefs = [
    ...baseToolDefs,
    ...children.map((c) => makeDelegateTool(scope.displayRoot, c)),
  ]
  const toolkit = Toolkit.make(
    ...(toolDefs as ReadonlyArray<Tool.Any>),
  ) as unknown as Toolkit.Toolkit<Record<string, Tool.Any>>

  const binding = {
    rootDir: scope.rootDir,
    displayRoot: scope.displayRoot,
    enforceWrite: scope.enforceWrite,
    allowBash: opts.allowBash ?? true,
  }

  const makeDelegateHandler =
    (child: Scope) =>
    ({ task }: { readonly task: string }) =>
      Effect.gen(function* () {
        const filesRef = yield* Ref.make<ReadonlyArray<string>>([])
        const usageRef = yield* Ref.make({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 })
        if (hooks?.onSubAgentStart) {
          yield* hooks.onSubAgentStart({ name: child.name, task })
        }
        const innerHooks = makeInnerHooks(hooks, filesRef, usageRef)
        const childRuntime = buildScopeRuntime(child, opts, innerHooks, depth + 1)

        const emitEnd = (ok: boolean, summary: string) =>
          Effect.gen(function* () {
            if (!hooks?.onSubAgentEnd) return
            const files = yield* Ref.get(filesRef)
            const usage = yield* Ref.get(usageRef)
            yield* hooks.onSubAgentEnd({
              name: child.name,
              ok,
              summary,
              filesChanged: files,
              ...(usage.outputTokens > 0 || usage.inputTokens > 0 ? { usage } : {}),
            })
          })

        const messages: ReadonlyArray<AgentMessage> = [
          { role: "user", content: task },
        ]
        const res = yield* runAgentLoop({
          system: child.systemPrompt,
          messages,
          toolkit: childRuntime.toolkit,
          maxSteps: opts.maxSteps ?? 12,
          hooks: innerHooks,
        }).pipe(
          Effect.provide(childRuntime.handlerLayer),
          Effect.tap((r) => emitEnd(true, r.finalText)),
          Effect.tapError(() => emitEnd(false, "")),
        )

        const filesChanged = yield* Ref.get(filesRef)
        return { summary: res.finalText, filesChanged }
      }).pipe(Effect.catchAll((e) => Effect.fail(toFailure(e))))

  const handlerLayer = toolkit.toLayer(
    Effect.gen(function* () {
      const base = yield* makeCodingHandlers(binding, opts.skills)
      const delegates: Record<string, unknown> = {}
      for (const child of children) {
        delegates[delegateName(child)] = makeDelegateHandler(child)
      }
      return { ...base, ...delegates } as never
    }),
  )

  return { toolkit, handlerLayer }
}
