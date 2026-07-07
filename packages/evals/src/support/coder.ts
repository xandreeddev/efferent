import { homedir } from "node:os"
import { Effect, Ref } from "effect"
import {
  ApprovalAllowAllLive,
  type AgentHooks,
  buildScopeRuntime,
  coderAgentConfig,
  coderPrompt,
  ConversationStore,
  discoverInstructionFiles,
  discoverScopeTree,
  loadAgents,
  loadMemory,
  loadSkills,
  loadTools,
  runAgent,
} from "@xandreed/sdk-core"
import { UnavailableVerifierLive } from "@xandreed/sdk-adapters"
// The built-in fleet stays a CLI concern — the ONE remaining efferent/* import
// (baselined debt; the routing/fleet suites need the real roster).
import { withBuiltinAgents } from "efferent/usecases/directive.js"
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

/** Build the root coder config for `dir` exactly as `main.ts` does.
 *  `codeModelConfigured` mirrors `main.ts` `discoverWorkspace`: when a distinct
 *  code model is set it emits the `# Writing code` delegation policy, so routing
 *  evals exercise the real prompt the agent ships with.
 *
 *  `includeFleet` mirrors `main.ts`'s `withBuiltinAgents` — it merges the
 *  built-in coordinator / research-coordinator / specialist roster into the
 *  loaded agents, so the `# When to delegate` policy is actually EMITTED and a
 *  `run_agent({ agent: "research-coordinator" })` resolves to the real fleet
 *  (instead of `resolveAgent` failing `UnknownAgent` and the model degrading to
 *  a generic spawn). Off by default so the focused-behaviour suites keep their
 *  lean prompt; the routing/fleet suites opt in. The Opus gate phase is left OFF
 *  (`autoLoop: false`) — evals have no `claude`, and a routing eval measures the
 *  DELEGATION decision, which happens before any gate. */
export const buildCoderConfig = (
  dir: string,
  transform: (base: string) => string = (s) => s,
  variant?: string,
  codeModelConfigured = false,
  hooks?: AgentHooks,
  includeFleet = false,
) =>
  Effect.gen(function* () {
    const skills = yield* loadSkills(dir, homedir())
    const memory = yield* loadMemory(dir, homedir())
    const loaded = yield* loadAgents(dir, homedir())
    const agents = includeFleet
      ? withBuiltinAgents(loaded, { autoLoop: false, maxLoopAttempts: 1 })
      : loaded
    const tools = yield* loadTools(dir, homedir())
    const instructionFiles = yield* discoverInstructionFiles(dir, homedir())
    const prompt = coderPrompt(dir, new Date(), skills, instructionFiles, agents, tools, variant, memory, codeModelConfigured)
    const rootScope = yield* discoverScopeTree(dir, (_children, body) => {
      const base = transform(prompt.text)
      return body !== undefined && body.trim().length > 0
        ? `${base}\n\n# Project scope\n\n${body}`
        : base
    })
    // Pass hooks so SUB-AGENT lifecycle events (onSubAgentStart with `role`,
    // onSubAgentEnd, per-tier onAssistantMessage) reach the caller — the
    // trajectory harness needs them; runCoder passes none (unchanged).
    const runtime = buildScopeRuntime(rootScope, { skills, memory, agents, tools, allowBash: true }, hooks)
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
        // No `claude` in evals: the verify gate reports unavailable (so the
        // toolkit's Verifier requirement resolves without shelling out).
        Effect.provide(UnavailableVerifierLive),
      )

      const tools = yield* Ref.get(toolsRef)
      const readback: Record<string, string> = {}
      for (const rel of opts.readback ?? []) readback[rel] = readWorkspaceFile(dir, rel)

      return { tools, finalText: result.finalText, files: readback }
    }),
  )
