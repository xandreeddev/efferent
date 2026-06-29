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
import { UnavailableVerifierLive } from "@xandreed/sdk-adapters"
import type { EvalEnv } from "../env.js"
import { buildCoderConfig } from "./coder.js"
import { dockerShellLayer, type Sandbox, withSandbox } from "./dockerSandbox.js"
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
  /** Paths this sub-agent changed — for the writer-overlap (duplicated/conflicting work) metric. */
  readonly files: ReadonlyArray<string>
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
  /** Tool names the ROOT called *itself* (`subAgentNodeId === undefined`) — distinct
   *  from {@link ScenarioRun.tools}, which includes sub-agents' calls. Lets a scorer
   *  assert the root kept its hands off code/research and only orchestrated. */
  readonly rootTools: ReadonlyArray<string>
  /** The `agent` type of each `run_agent` call the ROOT made (e.g. `"coordinator"`,
   *  `"research-coordinator"`) — to assert the root routed through a LEAD rather than
   *  spawning workers directly. `undefined` agent (a plain role spawn) is recorded as
   *  the empty string so a direct-worker spawn is still visible/penalizable. */
  readonly rootSpawnedAgents: ReadonlyArray<string>
}

/** The verdict from running a scenario's HIDDEN test suite against the agent's
 *  produced code — the objective discriminator a graded rubric can't fake. */
export interface TestResult {
  readonly pass: number
  readonly fail: number
  /** pass / (pass + fail) over ALL hidden tests; 1 if green with no count, 0 if it couldn't load. */
  readonly ratio: number
  /** Exit 0, ≥1 pass, 0 fail — the binary all-pass (resists "9 easy / 1 hard" gaming). */
  readonly allPass: boolean
  /** Pass-ratio over just the EDGE-case tests (the sharper discriminator) when the
   *  scenario tags them; undefined otherwise. The overall `ratio` can be dominated
   *  by trivial happy-path tests — this isolates the hard cases. */
  readonly edgeRatio?: number
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
  /** The subset of `hiddenTests` that are EDGE-case tests — run separately to
   *  report `edgeRatio` (the sharper discriminator). They're also part of the
   *  overall run; this just isolates their pass-rate. */
  readonly edgeTestPaths?: ReadonlyArray<string>
  /** Run the agent's Bash AND the hidden tests inside a per-case Docker sandbox
   *  (`oven/bun`, `--network none`, bind-mounted temp dir) instead of on the host
   *  — the safe path for a suite that executes LLM-generated code. Mirrors the
   *  `repo-tasks` isolation. Requires Docker; defaults to off (host execution). */
  readonly sandbox?: boolean
  /** Merge the built-in fleet (coordinator / research-coordinator / specialists)
   *  into the roster, exactly as `main.ts` does with `withBuiltinAgents`. Required
   *  for any eval that measures whether the root DELEGATES to the fleet — without
   *  it the `# When to delegate` policy is never emitted and a
   *  `run_agent({ agent: "research-coordinator" })` fails `UnknownAgent`. Defaults
   *  off so the focused-behaviour suites keep their lean prompt. */
  readonly includeFleet?: boolean
}

const billed = (u?: { readonly inputTokens: number; readonly outputTokens: number }): number =>
  u === undefined ? 0 : u.inputTokens + u.outputTokens

/** Safely pull the `agent` (lead type) argument from a `run_agent` tool call's
 *  args; "" when absent (a plain role spawn with no named agent — a direct worker). */
const runAgentTargetAgent = (args: unknown): string => {
  if (typeof args === "object" && args !== null && "agent" in args) {
    const a = (args as { readonly agent?: unknown }).agent
    if (typeof a === "string") return a
  }
  return ""
}

const countMatch = (s: string, re: RegExp): number => {
  const m = s.match(re)
  return m !== null && m[1] !== undefined ? Number(m[1]) : 0
}

/** Parse `bun test`'s "N pass / N fail" summary (written to stderr) into a verdict. */
const parseTestOutput = (out: string, exitCode: number): TestResult => {
  const pass = countMatch(out, /(\d+)\s+pass/)
  const fail = countMatch(out, /(\d+)\s+fail/)
  const total = pass + fail
  const ratio = total > 0 ? pass / total : exitCode === 0 ? 1 : 0
  return { pass, fail, ratio, allPass: exitCode === 0 && fail === 0 && pass > 0, output: out.slice(0, 4000) }
}

const writeTests = (dir: string, tests: Record<string, string>): void => {
  for (const [rel, content] of Object.entries(tests)) {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
}

/** Run `bun test <paths>` on the HOST (the non-sandboxed path) and parse the
 *  verdict. Tests must already be written. Pure, dependency-free TS → no install;
 *  `spawnSync` captures both streams regardless of exit code. */
const runPathsHost = (dir: string, paths: ReadonlyArray<string>): TestResult => {
  const r = spawnSync("bun", ["test", ...paths], { cwd: dir, encoding: "utf8", timeout: 90_000 })
  return parseTestOutput(`${r.stdout ?? ""}\n${r.stderr ?? ""}`, r.status ?? 1)
}

/** Run `bun test <paths>` INSIDE the sandbox container (the isolated path). The
 *  tests live on the host but are visible in the container via the /work bind
 *  mount; the agent never sees them (written only after its run). */
const runPathsSandbox = (sb: Sandbox, paths: ReadonlyArray<string>): TestResult => {
  const r = sb.exec(`bun test ${paths.join(" ")}`, 90_000)
  return parseTestOutput(`${r.stdout}\n${r.stderr}`, r.exitCode)
}

export const runScenario = (
  files: Record<string, string>,
  prompt: string,
  opts: RunScenarioOptions = {},
): Effect.Effect<ScenarioRun, unknown, EvalEnv> =>
  withTempWorkspace(files, (dir) => {
    // When sandboxed, the agent's Bash + the hidden tests run inside a
    // `--network none` container (over the /work bind mount); otherwise on the host.
    const body = (sb?: Sandbox): Effect.Effect<ScenarioRun, unknown, EvalEnv> =>
      Effect.gen(function* () {
      const settings = yield* (yield* SettingsStore).get()
      const transform = opts.systemPromptOverride ?? ((s: string) => s)

      const toolsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const rootToolsRef = yield* Ref.make<ReadonlyArray<string>>([])
      const rootSpawnedRef = yield* Ref.make<ReadonlyArray<string>>([])
      const spawnsRef = yield* Ref.make<ReadonlyArray<Spawn>>([])
      const spendRef = yield* Ref.make<Record<Tier, number>>({ general: 0, code: 0, fast: 0 })
      const stepsRef = yield* Ref.make(0)

      const hooks: AgentHooks = {
        onBeforeToolCall: (e) =>
          Effect.gen(function* () {
            yield* Ref.update(toolsRef, (a) => [...a, e.toolName])
            // A root-issued call (no sub-agent node) — the signal for "what the root
            // did itself". `run_agent` from the root records which lead it spawned.
            if (e.subAgentNodeId === undefined) {
              yield* Ref.update(rootToolsRef, (a) => [...a, e.toolName])
              if (e.toolName === "run_agent") {
                yield* Ref.update(rootSpawnedRef, (a) => [...a, runAgentTargetAgent(e.args)])
              }
            }
            return { action: "continue" } as const
          }),
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
            { name: e.name, role: e.role ?? "general", ok: false, filesChanged: 0, files: [], tokens: 0 },
          ]),
        onSubAgentEnd: (e) =>
          Ref.update(spawnsRef, (a) => {
            // Close the most recent still-open spawn with this name.
            let done = false
            const next: Array<Spawn> = []
            for (let i = a.length - 1; i >= 0; i--) {
              const s = a[i]!
              if (!done && s.name === e.name && !s.ok) {
                next.push({
                  ...s,
                  ok: e.ok,
                  filesChanged: e.filesChanged.length,
                  files: e.filesChanged,
                  tokens: billed(e.usage),
                })
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
        opts.includeFleet === true,
      )
      const store = yield* ConversationStore
      const id = yield* store.create(dir)

      // In the sandbox, override the agent's Shell with the container exec layer
      // (inner provide wins over the env's host LocalShellLive); file tools stay
      // on the host over the bind mount, exactly as `repo-tasks` does it.
      const baseRun = runAgent(config, id, prompt, hooks, dir).pipe(
        Effect.provide(runtime.handlerLayer),
        Effect.provide(ApprovalAllowAllLive),
        Effect.provide(UnavailableVerifierLive),
      )
      const result = yield* (sb !== undefined
        ? baseRun.pipe(Effect.provide(dockerShellLayer(sb)))
        : baseRun)

      const tools = yield* Ref.get(toolsRef)
      const rootTools = yield* Ref.get(rootToolsRef)
      const rootSpawnedAgents = yield* Ref.get(rootSpawnedRef)
      const spawns = yield* Ref.get(spawnsRef)
      const perTierSpend = yield* Ref.get(spendRef)
      const steps = yield* Ref.get(stepsRef)
      const readback: Record<string, string> = {}
      for (const rel of opts.readback ?? []) readback[rel] = readWorkspaceFile(dir, rel)

      // Objective discriminator: run the hidden test suite against what the agent
      // built (after the run, so it could never see or edit the tests).
      const testResult =
        opts.hiddenTests !== undefined
          ? yield* Effect.sync(() => {
              const tests = opts.hiddenTests!
              const allPaths = opts.testPaths ?? Object.keys(tests)
              writeTests(dir, tests)
              const run = (paths: ReadonlyArray<string>): TestResult =>
                sb !== undefined ? runPathsSandbox(sb, paths) : runPathsHost(dir, paths)
              const main = run(allPaths)
              // Edge-case tests run again on their own to isolate the sharper ratio.
              if (opts.edgeTestPaths !== undefined && opts.edgeTestPaths.length > 0) {
                return { ...main, edgeRatio: run(opts.edgeTestPaths).ratio }
              }
              return main
            })
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
          rootTools,
          rootSpawnedAgents,
        },
        ...(testResult !== undefined ? { testResult } : {}),
      }
      })
    return opts.sandbox === true ? withSandbox(dir, body) : body()
  })
