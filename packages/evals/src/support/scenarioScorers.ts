import { Effect } from "effect"
import type { Scorer } from "../framework/Eval.js"
import type { ScenarioRun } from "./scenarioRun.js"

/**
 * Ground-truth labels for a scenario's expected ROUTING behaviour — the thing
 * the recurring "it ran on the root general model, not the coder" complaint is
 * about. Scored objectively from the captured {@link ScenarioRun.trajectory},
 * so it's deterministic (no judge).
 */
export interface RoutingExpectation {
  /** Whether the task SHOULD provoke delegation to a sub-agent. A coding task
   *  (with a distinct codeModel) should; a pure Q&A / read-only task should not. */
  readonly shouldDelegate?: boolean
  /** When code is written, the tier it should run on. `code` ⇒ the code-writing
   *  must hit the code tier; `general` ⇒ no code-tier spend at all. */
  readonly codingTier?: "code" | "general"
  /** When delegation is expected, the minimum number of sub-agents — the
   *  parallel FAN-OUT. A broad investigation's speed-up comes from ≥2 concurrent
   *  read-only researchers, not one serial sub-agent; this makes "actually used
   *  the swarm" measurable, so a root that did the reading itself scores a clean
   *  0 (with `shouldDelegate`) rather than a soft pass. Only checked when
   *  `shouldDelegate === true`. */
  readonly minSpawns?: number
  /** The root must ORCHESTRATE: do NIL coding/research itself AND actually
   *  delegate. Any root-issued work tool is impurity — but since the orchestrate
   *  root mechanically *can't* call one, "didn't code" is trivially true; the real
   *  failure mode is the root spinning on housekeeping (`update_plan`/`blackboard`/
   *  `list_scheduled_jobs`) and never spawning a lead. So this also requires a
   *  delegation. Scored by {@link orchestratorPurityScore}. */
  readonly rootMustNotCode?: boolean
  /** The LEAD the root must route through — `run_agent({ agent })`: `"coordinator"`
   *  for code work, `"research-coordinator"` for investigation. The root spawning
   *  workers directly (no lead) fails this. Scored by {@link orchestratorPurityScore}. */
  readonly expectLead?: "coordinator" | "research-coordinator"
}

/** Tools that count as the root "doing the work itself" (vs orchestrating). */
const WORK_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "grep",
  "glob",
  "ls",
  "Bash",
  "search_web",
  "web_fetch",
])

export interface EfficiencyBudget {
  /** Soft cap on root loop steps; over-budget decays the score linearly. */
  readonly maxSteps?: number
}

/**
 * Score the routing/agent-selection decisions, averaging the applicable checks:
 * delegate-or-not match, code-tier usage when coding, no code-tier when it
 * shouldn't, and an over-spawn penalty on tasks that should stay direct.
 * Returns 1 when no routing expectation is set (the scenario doesn't care).
 */
export const routingScore = <I, T extends { readonly routing?: RoutingExpectation }>(
  name = "routing",
): Scorer<I, ScenarioRun, T> => ({
  name,
  score: ({ output, expected }) =>
    Effect.sync(() => {
      const exp = expected.routing
      if (exp === undefined) return 1
      const t = output.trajectory
      const checks: number[] = []
      if (exp.shouldDelegate !== undefined) {
        checks.push(t.delegated === exp.shouldDelegate ? 1 : 0)
        // A task that should stay direct but fanned out is worse the more it spawned.
        if (exp.shouldDelegate === false && t.spawns.length > 0)
          checks.push(Math.max(0, 1 - t.spawns.length * 0.5))
        // A task that should delegate must actually FAN OUT (≥ minSpawns parallel
        // readers), not spawn a single serial sub-agent — that's "used the swarm".
        if (exp.shouldDelegate === true && exp.minSpawns !== undefined)
          checks.push(t.spawns.length >= exp.minSpawns ? 1 : 0)
      }
      if (exp.codingTier === "code") checks.push(t.usedCodeTier ? 1 : 0)
      if (exp.codingTier === "general") checks.push(t.perTierSpend.code === 0 ? 1 : 0)
      return checks.length === 0 ? 1 : checks.reduce((a, b) => a + b, 0) / checks.length
    }),
})

/**
 * Score the root's ORCHESTRATOR PURITY — the "root should aggregate + delegate, do
 * nil coding/research itself" property. Deterministic, from the trajectory's
 * root-only signals (`rootTools`, `rootSpawnedAgents`). Averages the applicable
 * checks; returns 1 when no purity expectation is set.
 *   - `rootMustNotCode` → the root must have orchestrated: zero {@link WORK_TOOLS}
 *     calls AND at least one delegation. Coding itself decays per work-call;
 *     looping on housekeeping with NO spawn scores 0 (the live failure — the root
 *     can't code anymore, so "no work tools" alone is meaningless and used to mask
 *     a root that spun on `update_plan`/`blackboard_read` and never delegated).
 *   - `expectLead` → the root must have routed through that lead (coordinator /
 *     research-coordinator), not spawned workers directly.
 */
export const orchestratorPurityScore = <I, T extends { readonly routing?: RoutingExpectation }>(
  name = "orchestrator_purity",
): Scorer<I, ScenarioRun, T> => ({
  name,
  score: ({ output, expected }) =>
    Effect.sync(() => {
      const exp = expected.routing
      if (exp === undefined) return 1
      const t = output.trajectory
      const checks: number[] = []
      if (exp.rootMustNotCode === true) {
        const workCalls = t.rootTools.filter((n) => WORK_TOOLS.has(n)).length
        const delegated = t.rootSpawnedAgents.length > 0
        checks.push(
          workCalls > 0
            ? Math.max(0, 1 - workCalls * 0.25) // coded itself → impure
            : delegated
              ? 1 // orchestrated cleanly: no work tools, and it delegated
              : 0, // looped on housekeeping and never spawned a lead — the bug
        )
      }
      if (exp.expectLead !== undefined) {
        checks.push(t.rootSpawnedAgents.includes(exp.expectLead) ? 1 : 0)
      }
      return checks.length === 0 ? 1 : checks.reduce((a, b) => a + b, 0) / checks.length
    }),
})

/** Score loop efficiency: 1 within the step budget, decaying linearly over it. */
export const efficiencyScore = <I, T extends { readonly budget?: EfficiencyBudget }>(
  name = "efficiency",
): Scorer<I, ScenarioRun, T> => ({
  name,
  score: ({ output, expected }) =>
    Effect.sync(() => {
      const max = expected.budget?.maxSteps
      if (max === undefined || max <= 0) return 1
      const steps = output.trajectory.steps
      return steps <= max ? 1 : Math.max(0, 1 - (steps - max) / max)
    }),
})

/** Tools that mutate the workspace — a read-only investigation must use NONE
 *  (fleet-wide). Mirrors core's `MUTATING_TOOL_NAMES`. */
const RESEARCH_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  "write_file",
  "edit_file",
  "Bash",
])

/**
 * Guard for Fix 3 — a research investigation must stay READ-ONLY across the whole
 * fleet. Even when the prompt says "find AND fix", a research-coordinator
 * investigates and recommends; it must not write code or spawn a coder. Only
 * checked when `expected.researchReadOnly === true`.
 *
 * NOT VACUOUS: a run that never delegated (no fleet ran) trivially has no writes,
 * but it didn't EXERCISE the read-only constraint — scoring it 1 would be a false
 * pass (the failure mode we actually hit live). So the guard scores 1 ONLY when
 * the fleet ran AND wrote nothing; no-delegation scores 0 with a clear detail, so
 * the property is never claimed without being tested. (Routing is scored
 * separately by `routingScore`.)
 */
export const researchReadOnlyScore = <
  I,
  T extends { readonly researchReadOnly?: boolean },
>(
  name = "research_read_only",
): Scorer<I, ScenarioRun, T> => ({
  name,
  score: ({ output, expected }) =>
    Effect.sync(() => {
      if (expected.researchReadOnly !== true) return 1
      if (!output.trajectory.delegated) {
        return {
          score: 0,
          detail: "no delegation — the read-only constraint was never exercised (not a vacuous pass)",
        }
      }
      const mutated = output.tools.filter((t) => RESEARCH_FORBIDDEN_TOOLS.has(t))
      return mutated.length === 0
        ? { score: 1, detail: "fleet ran and wrote nothing" }
        : { score: 0, detail: `research fleet used mutating tools: ${mutated.join(", ")}` }
    }),
})
