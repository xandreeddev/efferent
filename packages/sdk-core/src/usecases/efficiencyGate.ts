import { Effect } from "effect"
import type { ConversationId } from "../entities/Conversation.js"
import type { Candidate } from "../entities/Distillation.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"

/**
 * **Deterministic fleet-efficiency gate** — the no-LLM half of the
 * self-improving loop's "learn to converge" step. After a turn it reads the
 * persisted context tree for the run and, if the fleet clearly over-worked
 * (spawned far too many workers, or burned a large token budget), emits a
 * `research-budget` constraint the Curator persists verbatim — so the NEXT run
 * is prompted to right-size. Unlike the LLM distiller it ALWAYS fires and needs
 * no `claude`, and unlike the per-sub-agent fetch cap (which bounds ONE worker)
 * it catches the orthogonal runaway: too MANY workers, each individually capped.
 *
 * Deliberately egregious thresholds — a normal, right-sized fleet run produces
 * NO lesson (no noise); only genuine over-research trips it.
 */

/** Spawn count above which a run is treated as over-fanned (a small task does not
 *  need this many workers; each is fetch-capped, but N×cap is still a lot). */
export const EFFICIENCY_SPAWN_THRESHOLD = 8
/** Fleet billed-token sum above which a run is treated as over-spent. */
export const EFFICIENCY_TOKEN_THRESHOLD = 1_500_000

/** A canonical slug so persistArtifact MERGES repeat lessons (counter bump),
 *  never duplicates them. */
export const RESEARCH_BUDGET_SLUG = "fleet-research-budget"

export interface FleetEfficiency {
  /** Number of sub-agent nodes the run spawned (whole subtree). */
  readonly spawns: number
  /** Sum of billed tokens across those nodes. */
  readonly tokens: number
}

/** Read the persisted context tree for a run and sum its fleet metrics. Best-effort:
 *  a store error yields zeros (never breaks the turn). */
export const measureFleetEfficiency = (
  rootConversationId: ConversationId,
): Effect.Effect<FleetEfficiency, never, ContextTreeStore> =>
  Effect.gen(function* () {
    const store = yield* ContextTreeStore
    const nodes = yield* store
      .listTree(rootConversationId)
      .pipe(Effect.catchAll(() => Effect.succeed([])))
    let tokens = 0
    for (const n of nodes) {
      if (n.usage !== undefined) tokens += n.usage.inputTokens + n.usage.outputTokens
    }
    return { spawns: nodes.length, tokens }
  })

/** The `research-budget` constraint when a run over-worked, else null. Pure. */
export const efficiencyConstraint = (
  eff: FleetEfficiency,
  conversationId: ConversationId,
): Candidate | null => {
  const overSpawned = eff.spawns > EFFICIENCY_SPAWN_THRESHOLD
  const overSpent = eff.tokens > EFFICIENCY_TOKEN_THRESHOLD
  if (!overSpawned && !overSpent) return null
  return {
    kind: "constraint",
    name: RESEARCH_BUDGET_SLUG,
    description: "Right-size fleet effort to the task — don't over-research.",
    body:
      "Right-size the fleet to the task. A recent run over-worked it " +
      `(${eff.spawns} workers, ~${Math.round(eff.tokens / 1000)}k billed tokens). For a question ` +
      "answerable from a few sources, use ONE researcher and a couple of search_web calls; reserve a " +
      "multi-agent fleet for genuinely multi-axis or multi-package work. Stop and synthesize as soon as " +
      "you have a solid sourced answer — more workers and more fetches rarely improve a small answer.",
    // Derived from the context tree, not specific message rows — no positions.
    evidence: { conversationId: String(conversationId), positions: [] },
  }
}

/** Measure the run + return the over-research constraint (or null). */
export const efficiencyGate = (
  rootConversationId: ConversationId,
): Effect.Effect<Candidate | null, never, ContextTreeStore> =>
  measureFleetEfficiency(rootConversationId).pipe(
    Effect.map((eff) => efficiencyConstraint(eff, rootConversationId)),
  )
