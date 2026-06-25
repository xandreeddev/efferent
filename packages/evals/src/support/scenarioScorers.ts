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
}

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
      }
      if (exp.codingTier === "code") checks.push(t.usedCodeTier ? 1 : 0)
      if (exp.codingTier === "general") checks.push(t.perTierSpend.code === 0 ? 1 : 0)
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
