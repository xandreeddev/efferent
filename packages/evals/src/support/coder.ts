import { homedir } from "node:os"
import { Effect, Ref } from "effect"
import {
  ApprovalAllowAllLive,
  type AgentHooks,
  ConversationStore,
  runAgent,
} from "@efferent/sdk-core"
import { buildScopeRuntime } from "../../../cli/src/usecases/buildScopeRuntime.js"
import { coderAgentConfig } from "../../../cli/src/usecases/coderAgentConfig.js"
import { coderPrompt } from "../../../cli/src/prompts/coder.js"
import { discoverInstructionFiles } from "../../../cli/src/usecases/discoverInstructionFiles.js"
import { discoverScopeTree } from "../../../cli/src/usecases/discoverScopeTree.js"
import { loadSkills } from "../../../cli/src/usecases/loadSkills.js"
import type { EvalEnv } from "../env.js"
import { readWorkspaceFile, withTempWorkspace } from "./workspace.js"

export interface CoderRun {
  /** Tool names in call order across all turns. */
  readonly tools: ReadonlyArray<string>
  readonly finalText: string
  /** Contents of the `readback` files, read just before teardown. */
  readonly files: Record<string, string>
}

export interface RunCoderOptions {
  /** If set, tools NOT in this list are blocked (returned to the model as an error). */
  readonly allowTools?: ReadonlyArray<string>
  /** Stop the loop after the first turn that issues tool calls (bounds cost). */
  readonly stopAfterFirstToolTurn?: boolean
  /** Files to read back from the workspace before it's torn down. */
  readonly readback?: ReadonlyArray<string>
  /** Pure transform of the default coder system prompt (A/B a prompt variant). */
  readonly systemPromptOverride?: (base: string) => string
  /** Optional prompt variant name — surfaced on spans/metrics for A/B tracking. */
  readonly promptVariant?: string
}

/** Build the root coder config for `dir` exactly as `main.ts` does. */
export const buildCoderConfig = (
  dir: string,
  transform: (base: string) => string = (s) => s,
  variant?: string,
) =>
  Effect.gen(function* () {
    const skills = yield* loadSkills(dir, homedir())
    const instructionFiles = yield* discoverInstructionFiles(dir, homedir())
    const prompt = coderPrompt(dir, new Date(), skills, instructionFiles, variant)
    const rootScope = yield* discoverScopeTree(dir, (_children, body) => {
      const base = transform(prompt.text)
      return body !== undefined && body.trim().length > 0
        ? `${base}\n\n# Project scope\n\n${body}`
        : base
    })
    const runtime = buildScopeRuntime(rootScope, { skills, allowBash: true })
    return { config: coderAgentConfig(rootScope, runtime, prompt), runtime }
  })

/**
 * Stand up a real coder agent over `files`, run `prompt`, and report which
 * tools it called, its final text, and the post-run contents of `readback`
 * files. The temp workspace is created and removed around the run. Token / step
 * / latency data is NOT collected here — the instrumented agent loop annotates
 * its own spans, which the eval runner reads back from the in-memory exporter.
 */
export const runCoder = (
  files: Record<string, string>,
  prompt: string,
  opts: RunCoderOptions = {},
): Effect.Effect<CoderRun, unknown, EvalEnv> =>
  withTempWorkspace(files, (dir) =>
    Effect.gen(function* () {
      const transform = opts.systemPromptOverride ?? ((s: string) => s)
      const { config, runtime } = yield* buildCoderConfig(dir, transform, opts.promptVariant)
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
