import { homedir } from "node:os"
import { Effect, Ref } from "effect"
import {
  ApprovalAllowAllLive,
  type AgentHooks,
  buildScopeRuntime,
  coderAgentConfig,
  coderSystemPrompt,
  ConversationStore,
  discoverInstructionFiles,
  discoverScopeTree,
  loadSkills,
  runAgent,
} from "@efferent/core"
import type { EvalEnv } from "../env.js"
import { readWorkspaceFile, withTempWorkspace } from "./workspace.js"

export interface CoderRun {
  /** Tool names in call order across all turns. */
  readonly tools: ReadonlyArray<string>
  readonly finalText: string
  /** Contents of the `readback` files, read just before teardown. */
  readonly files: Record<string, string>
}

/** Build the root coder config for `dir` exactly as `main.ts` does. */
const buildConfig = (dir: string) =>
  Effect.gen(function* () {
    const skills = yield* loadSkills(dir, homedir())
    const instructionFiles = yield* discoverInstructionFiles(dir, homedir())
    const rootScope = yield* discoverScopeTree(dir, (_children, body) => {
      const base = coderSystemPrompt(dir, new Date(), skills, instructionFiles)
      return body !== undefined && body.trim().length > 0
        ? `${base}\n\n# Project scope\n\n${body}`
        : base
    })
    const runtime = buildScopeRuntime(rootScope, { skills, allowBash: true })
    return { config: coderAgentConfig(rootScope, runtime), runtime }
  })

export interface RunCoderOptions {
  /** If set, tools NOT in this list are blocked (returned to the model as an error). */
  readonly allowTools?: ReadonlyArray<string>
  /** Stop the loop after the first turn that issues tool calls (bounds cost). */
  readonly stopAfterFirstToolTurn?: boolean
  /** Files to read back from the workspace before it's torn down. */
  readonly readback?: ReadonlyArray<string>
}

/**
 * Stand up a real coder agent over `files`, run `prompt`, and report which
 * tools it called, its final text, and the post-run contents of `readback`
 * files. The temp workspace is created and removed around the run.
 */
export const runCoder = (
  files: Record<string, string>,
  prompt: string,
  opts: RunCoderOptions = {},
): Effect.Effect<CoderRun, unknown, EvalEnv> =>
  withTempWorkspace(files, (dir) =>
    Effect.gen(function* () {
      const { config, runtime } = yield* buildConfig(dir)
      const store = yield* ConversationStore
      const id = yield* store.create(dir)
      const toolsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const allow = opts.allowTools !== undefined ? new Set(opts.allowTools) : undefined

      const hooks: AgentHooks = {
        onBeforeToolCall: (e) =>
          Ref.update(toolsRef, (a) => [...a, e.toolName]).pipe(
            Effect.as(
              allow === undefined || allow.has(e.toolName)
                ? ({ action: "continue" } as const)
                : ({
                    action: "block",
                    reason: `tool '${e.toolName}' is not permitted in this eval`,
                  } as const),
            ),
          ),
        ...(opts.stopAfterFirstToolTurn === true
          ? { onShouldStopAfterTurn: () => Effect.succeed(true) }
          : {}),
      }

      const result = yield* runAgent(config, id, prompt, hooks, dir).pipe(
        Effect.provide(runtime.handlerLayer),
        // Evals never prompt: static allow-all approval.
        Effect.provide(ApprovalAllowAllLive),
      )

      const tools = yield* Ref.get(toolsRef)
      const readback: Record<string, string> = {}
      for (const rel of opts.readback ?? []) readback[rel] = readWorkspaceFile(dir, rel)

      return { tools, finalText: result.finalText, files: readback }
    }),
  )
