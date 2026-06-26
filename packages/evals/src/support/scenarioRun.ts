import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Ref } from "effect"
import {
  type AgentHooks,
  type AgentModelRole,
  ApprovalAllowAllLive,
  codeModelDistinct,
  ConversationStore,
  runAgent,
  SettingsStore,
} from "@xandreed/sdk-core"
import type { EvalEnv } from "../env.js"
import { buildCoderConfig } from "./coder.js"
import { readWorkspaceFile, withTempWorkspace } from "./workspace.js"

/**
 * The black-box scenario harness. Runs the REAL agent loop over a temp repo and
 * captures, in addition to {@link CoderRun}'s tools/finalText/files, the run's
 * **trajectory** — what the agent *did* structurally — so a scorer can judge the
 * routing/agent-selection decisions, not just the final artifact.
 *
 * The trajectory is captured purely from {@link AgentHooks}: the same hooks are
 * given to BOTH `runAgent` (root loop → `onAssistantMessage` steps + general
 * spend) AND `buildScopeRuntime` (sub-agent spawns → `onSubAgentStart` with the
 * tier `role`, `onSubAgentEnd`, and per-tier `onAssistantMessage`). No
 * context-tree query needed. The eval config's distinct `codeModel` (via
 * `RunConfig.code`) drives `codeModelDistinct`, so the `# Writing code` policy
 * is actually present and the code-tier routing is exercised.
 */

const TIERS = ["general", "code", "fast"] as const
export type Tier = (typeof TIERS)[number]

export interface Spawn {
  readonly name: string
  /** The tier the spawn was launched on (`run_agent({ role })`). */
  readonly role: AgentModelRole
  readonly ok: boolean
  readonly filesChanged: number
  /** Cumulative billed tokens for this sub-agent's run. */
  readonly tokens: number
}

export interface Trajectory {
  /** Did the root spawn ANY sub-agent? */
  readonly delegated: boolean
  /** Whether any sub-agent ran on the `code` tier (the code-writing was delegated). */
  readonly usedCodeTier: boolean
  readonly spawns: ReadonlyArray<Spawn>
  /** Billed tokens (input+output) per tier, root + all sub-agents. */
  readonly perTierSpend: Record<Tier, number>
  /** Root assistant turns (loop steps). */
  readonly steps: number
}

/** The verdict from running a scenario's HIDDEN test suite against the agent's
 *  produced code — the objective discriminator a graded rubric can't fake. */
export interface TestResult {
  readonly pass: number
  readonly fail: number
  /** pass / (pass + fail); 1 if the suite is green with no parseable count, 0 if it couldn't load. */
  readonly ratio: number
  /** Exit 0, ≥1 pass, 0 fail. */
  readonly allPass: boolean
  readonly output: string
}

export interface ScenarioRun {
  readonly tools: ReadonlyArray<string>
  readonly finalText: string
  readonly files: Record<string, string>
  readonly trajectory: Trajectory
  /** Present only when the scenario shipped `hiddenTests`. */
  readonly testResult?: TestResult
}

export interface RunScenarioOptions {
  readonly readback?: ReadonlyArray<string>
  readonly systemPromptOverride?: (base: string) => string
  readonly promptVariant?: string
  /** Test files (workspace-relative) written AFTER the agent run — so the agent
   *  can't read or edit them — then executed with `bun test` for an objective
   *  pass-ratio. The agent never sees these; it must infer the full spec from
   *  the prompt (which is exactly what separates a strong coder from a weak one). */
  readonly hiddenTests?: Record<string, string>
  /** Which of `hiddenTests` to run (defaults to all of them). */
  readonly testPaths?: ReadonlyArray<string>
}

const billed = (u?: { readonly inputTokens: number; readonly outputTokens: number }): number =>
  u === undefined ? 0 : u.inputTokens + u.outputTokens

const countMatch = (s: string, re: RegExp): number => {
  const m = s.match(re)
  return m !== null && m[1] !== undefined ? Number(m[1]) : 0
}

/** Write the hidden tests into the finished workspace and run `bun test` over
 *  them (no Docker — the scenarios are pure, dependency-free TS, so the built-in
 *  runner needs no install). `bun test` exits non-zero on failures, which
 *  `execFileSync` throws on; we capture stdout/stderr from the error either way. */
const runHiddenTests = (
  dir: string,
  tests: Record<string, string>,
  testPaths: ReadonlyArray<string>,
): TestResult => {
  for (const [rel, content] of Object.entries(tests)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  // bun test writes its "N pass / N fail" summary to STDERR and exits non-zero on
  // failures; spawnSync captures both streams regardless of exit code (no throw).
  const r = spawnSync("bun", ["test", ...testPaths], {
    cwd: dir,
    encoding: "utf8",
    timeout: 90_000,
  })
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`
  const exitCode = r.status ?? 1
  const pass = countMatch(out, /(\d+)\s+pass/)
  const fail = countMatch(out, /(\d+)\s+fail/)
  const total = pass + fail
  const ratio = total > 0 ? pass / total : exitCode === 0 ? 1 : 0
  return { pass, fail, ratio, allPass: exitCode === 0 && fail === 0 && pass > 0, output: out.slice(0, 4000) }
}

export const runScenario = (
  files: Record<string, string>,
  prompt: string,
  opts: RunScenarioOptions = {},
): Effect.Effect<ScenarioRun, unknown, EvalEnv> =>
  withTempWorkspace(files, (dir) =>
    Effect.gen(function* () {
      const settings = yield* (yield* SettingsStore).get()
      const transform = opts.systemPromptOverride ?? ((s: string) => s)

      const toolsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const spawnsRef = yield* Ref.make<ReadonlyArray<Spawn>>([])
      const spendRef = yield* Ref.make<Record<Tier, number>>({ general: 0, code: 0, fast: 0 })
      const stepsRef = yield* Ref.make(0)

      const hooks: AgentHooks = {
        onBeforeToolCall: (e) =>
          Ref.update(toolsRef, (a) => [...a, e.toolName]).pipe(
            Effect.as({ action: "continue" } as const),
          ),
        onAssistantMessage: (e) =>
          Effect.gen(function* () {
            // A ROOT turn (no sub-agent node) is a loop step billed to `general`;
            // a sub-agent turn bills its own tier (carried on the event).
            if (e.subAgentNodeId === undefined) {
              yield* Ref.update(stepsRef, (n) => n + 1)
              yield* Ref.update(spendRef, (s) => ({ ...s, general: s.general + billed(e.usage) }))
            } else {
              const tier: AgentModelRole = e.subAgentRole ?? "general"
              yield* Ref.update(spendRef, (s) => ({ ...s, [tier]: s[tier] + billed(e.usage) }))
            }
          }),
        onSubAgentStart: (e) =>
          Ref.update(spawnsRef, (a) => [
            ...a,
            { name: e.name, role: e.role ?? "general", ok: false, filesChanged: 0, tokens: 0 },
          ]),
        onSubAgentEnd: (e) =>
          Ref.update(spawnsRef, (a) => {
            // Close the most recent still-open spawn with this name.
            let done = false
            const next: Array<Spawn> = []
            for (let i = a.length - 1; i >= 0; i--) {
              const s = a[i]!
              if (!done && s.name === e.name && !s.ok) {
                next.push({ ...s, ok: e.ok, filesChanged: e.filesChanged.length, tokens: billed(e.usage) })
                done = true
              } else next.push(s)
            }
            return next.reverse()
          }),
        onHelperUsage: (e) =>
          Ref.update(spendRef, (s) => ({ ...s, fast: s.fast + billed(e.usage) })),
      }

      const { config, runtime } = yield* buildCoderConfig(
        dir,
        transform,
        opts.promptVariant,
        codeModelDistinct(settings),
        hooks,
      )
      const store = yield* ConversationStore
      const id = yield* store.create(dir)

      const result = yield* runAgent(config, id, prompt, hooks, dir).pipe(
        Effect.provide(runtime.handlerLayer),
        Effect.provide(ApprovalAllowAllLive),
      )

      const tools = yield* Ref.get(toolsRef)
      const spawns = yield* Ref.get(spawnsRef)
      const perTierSpend = yield* Ref.get(spendRef)
      const steps = yield* Ref.get(stepsRef)
      const readback: Record<string, string> = {}
      for (const rel of opts.readback ?? []) readback[rel] = readWorkspaceFile(dir, rel)

      // Objective discriminator: run the hidden test suite against what the agent
      // built (after the run, so it could never see or edit the tests).
      const testResult =
        opts.hiddenTests !== undefined
          ? yield* Effect.sync(() =>
              runHiddenTests(dir, opts.hiddenTests!, opts.testPaths ?? Object.keys(opts.hiddenTests!)),
            )
          : undefined

      return {
        tools,
        finalText: result.finalText,
        files: readback,
        trajectory: {
          delegated: spawns.length > 0,
          usedCodeTier: spawns.some((s) => s.role === "code") || perTierSpend.code > 0,
          spawns,
          perTierSpend,
          steps,
        },
        ...(testResult !== undefined ? { testResult } : {}),
      }
    }),
  )
