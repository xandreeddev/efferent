import { Clock, Effect, Either } from "effect"
import type { AgentContextNode, ContextNodeId } from "../entities/AgentContext.js"
import type { AgentGateEvent } from "../entities/AgentHooks.js"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import type { FileSystem } from "../ports/FileSystem.js"
import type { UtilityLlm } from "../ports/UtilityLlm.js"
import { Verifier } from "../ports/Verifier.js"
import { runAutoDistill } from "./autoDistill.js"

/** Max rounds the settle-wait polls for a run's NEW sub-agent nodes to reach a
 *  terminal status (2s each → ~30s ceiling) before the gate judges the objective
 *  on whatever has finished. */
const GATE_SETTLE_MAX_ROUNDS = 15

/** The tree for a conversation, or `[]` on any store error (best-effort: a tree
 *  read must never break the gate). */
export const listTreeSafe = (
  conversationId: ConversationId,
): Effect.Effect<ReadonlyArray<AgentContextNode>, never, ContextTreeStore> =>
  Effect.gen(function* () {
    const ct = yield* ContextTreeStore
    return yield* ct
      .listTree(conversationId)
      .pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<AgentContextNode>)))
  })

/** Poll (bounded) until the nodes matching `isFresh` have all left `running`, so
 *  the gate judges a finished objective rather than a mid-flight one. Returns the
 *  matching nodes. */
const settleBy = (
  conversationId: ConversationId,
  isFresh: (node: AgentContextNode) => boolean,
): Effect.Effect<ReadonlyArray<AgentContextNode>, never, ContextTreeStore> =>
  Effect.gen(function* () {
    let round = 0
    while (true) {
      const all = yield* listTreeSafe(conversationId)
      const fresh = all.filter(isFresh)
      if (!fresh.some((n) => n.status === "running") || round >= GATE_SETTLE_MAX_ROUNDS) {
        return fresh
      }
      yield* Clock.sleep("2 seconds")
      round++
    }
  })

/** Settle the run's NEW sub-agent nodes — those not present before the run (a
 *  resumed conversation already carries prior turns' nodes). Used by the ROOT
 *  aggregate gate. */
export const settleNewNodes = (
  conversationId: ConversationId,
  beforeIds: ReadonlySet<ContextNodeId>,
): Effect.Effect<ReadonlyArray<AgentContextNode>, never, ContextTreeStore> =>
  settleBy(conversationId, (n) => !beforeIds.has(n.id))

/** Settle a parent node's CHILD nodes — the workers a coordinator spawned this
 *  run. Used by the per-COORDINATOR gate (a fresh coordinator owns all its
 *  children; the root only ever spawns leads fresh, never resumes them). */
export const settleChildren = (
  conversationId: ConversationId,
  parentNodeId: ContextNodeId,
): Effect.Effect<ReadonlyArray<AgentContextNode>, never, ContextTreeStore> =>
  settleBy(conversationId, (n) => n.parentId === parentNodeId)

/** Prefix the verifier's reasons are fed back to the swarm under, the same at
 *  both tiers so a retry reads identically wherever it fires. */
export const GATE_FEEDBACK_PREAMBLE =
  "The independent verifier reviewed the swarm's work and it is NOT acceptable yet. " +
  "Address each issue below, then the work will be re-checked:\n"

/** What the caller should do after one gate round (see {@link gateOnce}). The
 *  caller emits `event` through its own hook (the hook's `R` differs per tier)
 *  and, on `retry`, runs `feedback` as the next attempt. */
export type GateStep =
  | { readonly kind: "no-subagents" }
  | { readonly kind: "accept"; readonly event: AgentGateEvent }
  | { readonly kind: "stop"; readonly event: AgentGateEvent }
  | { readonly kind: "retry"; readonly event: AgentGateEvent; readonly feedback: AgentMessage }

/**
 * One round of the mandatory swarm gate over a finished deliverable — the shared
 * core of the self-improving loop, used by BOTH the root aggregate gate
 * (`driveLoop`) and each coordinator's own gate (`buildScopeRuntime`), so the
 * validate→learn→retry decision lives in exactly one place.
 *
 *   - no fresh sub-agent nodes → `no-subagents` (this run used no swarm; nothing to gate)
 *   - verifier unavailable → `stop` with an `unavailable` event (surfaced LOUDLY, never a silent pass)
 *   - `sound` → `accept`
 *   - `blocked`, or `needs_work` at the attempt cap → `stop` (emit the verdict, accept as-is)
 *   - `needs_work` under the cap → DISTILL (mine + Opus-verify reusable lessons), then `retry` with the reasons
 *
 * Pure decision + the learn side-effect; the caller owns the loop (settle →
 * gateOnce → emit → maybe retry → repeat) because the settle predicate, the
 * retry mechanism, and the emit hook all differ per tier.
 */
export const gateOnce = (params: {
  readonly task: string
  readonly summary: string
  readonly repoDir: string
  readonly conversationId: ConversationId
  readonly freshNodes: ReadonlyArray<AgentContextNode>
  readonly attempt: number
  readonly maxAttempts: number
  readonly autoDistill: boolean
}): Effect.Effect<
  GateStep,
  never,
  Verifier | ConversationStore | ContextTreeStore | UtilityLlm | FileSystem
> =>
  Effect.gen(function* () {
    // No sub-agents this run → the gate is the swarm case only; nothing to do.
    if (params.freshNodes.length === 0) return { kind: "no-subagents" }

    const verifier = yield* Verifier
    const filesChanged = Array.from(new Set(params.freshNodes.flatMap((n) => n.filesChanged)))
    const verdict = yield* verifier
      .gate({
        task: params.task,
        summary: params.summary,
        filesChanged,
        repoDir: params.repoDir,
      })
      .pipe(Effect.either)

    if (Either.isLeft(verdict)) {
      // No verdict was possible (no `claude` / verifier error). Surface it —
      // never a silent pass — but don't spin on a broken gate.
      return {
        kind: "stop",
        event: {
          verdict: "unavailable",
          reasons: [verdict.left.message],
          attempt: params.attempt,
          filesChanged,
        },
      }
    }

    const v = verdict.right
    if (v.verdict === "sound") {
      return {
        kind: "accept",
        event: { verdict: "sound", reasons: [], attempt: params.attempt, filesChanged },
      }
    }

    // needs_work / blocked — the deliverable is NOT accepted as-is.
    const event: AgentGateEvent = {
      verdict: v.verdict,
      reasons: v.reasons,
      attempt: params.attempt,
      filesChanged,
    }
    if (v.verdict === "blocked" || params.attempt >= params.maxAttempts) {
      return { kind: "stop", event }
    }

    // LEARN — mine + Opus-verify reusable skills/memories/constraints from this
    // failed attempt so they persist for future runs. Fail-soft by construction
    // (`runAutoDistill` never fails); gated by the caller's `autoDistill` knob.
    if (params.autoDistill) {
      yield* runAutoDistill({
        conversationId: params.conversationId,
        repoDir: params.repoDir,
        existing: [],
      })
    }

    // RUN AGAIN — feed the gate's concrete reasons back as the next turn so the
    // swarm fixes them (not a blind re-send), then re-gate.
    const feedback: AgentMessage = {
      role: "user",
      content: GATE_FEEDBACK_PREAMBLE + v.reasons.map((r) => `- ${r}`).join("\n"),
    }
    return { kind: "retry", event, feedback }
  })
