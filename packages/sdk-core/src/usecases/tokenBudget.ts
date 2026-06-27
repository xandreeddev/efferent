import { Effect, Ref } from "effect"
import type { ContextUsage } from "../entities/AgentContext.js"

/**
 * The sub-agent **token budget**: a shared pool of tokens (input + output,
 * i.e. what a provider actually bills per call) that every sub-agent spawned
 * within one top-level turn draws from. Depth/step limits bound *termination*;
 * the pool bounds *spend* — without it, a depth-6 tree with unbounded fan-out
 * is still an unbounded bill.
 *
 * The pool is a `Ref<number>` carried on `RunContext` (so it flows down the
 * spawn tree ambiently, like depth), shared — not sliced — across the subtree:
 * children race for the remainder, which keeps the accounting honest without
 * pre-committing tokens a child may never use. Exhaustion is *graceful* by
 * design: a drained pool fails the next spawn with a model-readable
 * `BudgetExhausted` (the model finishes the work itself) and stops a running
 * sub-agent at its next turn boundary (never mid-tool-call), surfacing the
 * stop reason in the node's summary so the parent knows the result is partial.
 */

/** Default pool: 10M tokens per top-level turn across all sub-agents — generous
 *  headroom so a fleet grinding on a real codebase or a deep research sweep
 *  doesn't exhaust mid-coordination (the old 1M cap stranded broad runs). Still a
 *  ceiling, not a target; `:set subAgentTokenBudget 0` removes the cap entirely. */
export const DEFAULT_SUB_AGENT_TOKEN_BUDGET = 10_000_000

/** A live pool, or `null` when the budget is disabled (`<= 0`). */
export type TokenPool = Ref.Ref<number> | null

export const makeTokenPool = (
  budget: number,
): Effect.Effect<TokenPool> =>
  budget > 0 ? Ref.make(budget) : Effect.succeed(null)

/** Tokens a single LLM call costs the pool: what the provider bills. */
export const usageCost = (u: ContextUsage): number =>
  u.inputTokens + u.outputTokens

/** Drain one call's usage from the pool (no-op when disabled). */
export const drainPool = (
  pool: TokenPool,
  u: ContextUsage,
): Effect.Effect<void> =>
  pool === null ? Effect.void : Ref.update(pool, (n) => n - usageCost(u))

/** True when the pool exists and is spent (disabled pools never exhaust). */
export const poolExhausted = (pool: TokenPool): Effect.Effect<boolean> =>
  pool === null ? Effect.succeed(false) : Ref.get(pool).pipe(Effect.map((n) => n <= 0))

/** The model-facing failure for a spawn attempted on a drained pool. */
export const budgetExhaustedFailure = {
  error: "BudgetExhausted",
  message:
    "the sub-agent token budget for this turn is exhausted — do the remaining work yourself instead of spawning.",
} as const

/** Appended to a sub-agent's summary when the pool stopped it early. */
export const BUDGET_STOP_NOTE =
  "[stopped early: the shared sub-agent token budget ran out — this result is partial]"
