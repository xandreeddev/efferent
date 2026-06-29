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

/** Default pool: 4M tokens per top-level turn across all sub-agents — more
 *  headroom than the old 1M (which stranded broad runs mid-coordination), but
 *  still a real SAFETY brake against a fleet over-researching a small task (10M
 *  let a "compare 3 frameworks" run balloon to 160+ fetches without converging).
 *  A ceiling, not a target — the fleet should STOP when it has enough, not spend
 *  to the cap. `:set subAgentTokenBudget 0` removes it for genuine long-running. */
export const DEFAULT_SUB_AGENT_TOKEN_BUDGET = 4_000_000

/** A live pool, or `null` when the budget is disabled (`<= 0`). */
export type TokenPool = Ref.Ref<number> | null

export const makeTokenPool = (
  budget: number,
): Effect.Effect<TokenPool> =>
  budget > 0 ? Ref.make(budget) : Effect.succeed(null)

/**
 * What a provider bills cache-read (cached-prefix) tokens, as a fraction of a
 * fresh input token. Providers charge a steep discount for cache hits — Anthropic
 * ~0.1×, OpenAI ~0.25–0.5×, the opencode/Kimi gateway ~0.1×. We use 0.1× as a
 * conservative single factor (it slightly UNDER-counts on OpenAI, which is the
 * safe direction for a spend brake).
 */
export const CACHE_READ_COST_FACTOR = 0.1

/**
 * Tokens a single LLM call costs the pool — what the provider ACTUALLY bills.
 *
 * `u.inputTokens` is the WHOLE prompt for the call, and `u.cacheReadTokens` is
 * the cached-prefix portion of it (a subset). Billing the cached portion at full
 * price is the bug that drained a multi-turn fleet's budget ~8× too fast: every
 * turn re-sends the (byte-stable, cached) prefix, and counting it as fresh spend
 * penalizes exactly the prompt-cache design that makes the fleet cheap. So we
 * charge the fresh portion at 1× and the cached portion at {@link
 * CACHE_READ_COST_FACTOR}. A genuine runaway (lots of NEW context / fetches /
 * output) still trips the brake — only efficient cache reuse stops being taxed.
 */
export const usageCost = (u: ContextUsage): number => {
  const cached = Math.min(Math.max(0, u.cacheReadTokens), u.inputTokens)
  const fresh = u.inputTokens - cached
  return fresh + cached * CACHE_READ_COST_FACTOR + u.outputTokens
}

/** Drain one call's usage from the pool (no-op when disabled). */
export const drainPool = (
  pool: TokenPool,
  u: ContextUsage,
): Effect.Effect<void> =>
  pool === null ? Effect.void : Ref.update(pool, (n) => n - usageCost(u))

/** True when the pool exists and is spent (disabled pools never exhaust). */
export const poolExhausted = (pool: TokenPool): Effect.Effect<boolean> =>
  pool === null ? Effect.succeed(false) : Ref.get(pool).pipe(Effect.map((n) => n <= 0))

/** The model-facing failure for a spawn attempted on a drained pool.
 *  Deliberately does NOT say "do it yourself": that collapsed an entire fleet
 *  onto the root/coordinator when the budget ran out (un-delegated implementation
 *  on the lead). Instead it tells the lead to WRAP UP with what's already in hand
 *  and hand any remaining work back to its caller, who can resume with a fresh
 *  per-turn budget — keeping the work where it belongs. */
export const budgetExhaustedFailure = {
  error: "BudgetExhausted",
  message:
    "the sub-agent token budget for this turn is exhausted — stop spawning. Synthesize and return the best result you can from the work already completed, and note in your summary any remaining work so the caller can pick it up in a fresh turn (do NOT switch to doing that remaining work inline here).",
} as const

/** Appended to a sub-agent's summary when the pool stopped it early. */
export const BUDGET_STOP_NOTE =
  "[stopped early: the shared sub-agent token budget ran out — this result is partial]"
