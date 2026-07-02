import { Clock, Effect, Either } from "effect"
import type { AgentContextNode, ContextNodeId } from "../entities/AgentContext.js"
import type { AgentGateEvent } from "../entities/AgentHooks.js"
import type { AgentMessage, ConversationId } from "../entities/Conversation.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { Verifier } from "../ports/Verifier.js"

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

/** All transitive descendants of `rootId` within `nodes` (excludes `rootId`
 *  itself). Built from the parent links so the whole subtree — not just direct
 *  children — is returned, which is what makes the per-coordinator gate's
 *  `filesChanged` union cover a writer nested below an intermediate node (e.g. a
 *  coordinator → implementer → helper chain, or any depth > 1). Without this the
 *  gate could see a coordinator's subtree as file-less and judge it as prose. */
const descendantsOf = (
  nodes: ReadonlyArray<AgentContextNode>,
  rootId: ContextNodeId,
): ReadonlyArray<AgentContextNode> => {
  const childrenByParent = new Map<ContextNodeId, AgentContextNode[]>()
  for (const n of nodes) {
    if (n.parentId === null) continue
    const arr = childrenByParent.get(n.parentId) ?? []
    arr.push(n)
    childrenByParent.set(n.parentId, arr)
  }
  const out: AgentContextNode[] = []
  const seen = new Set<ContextNodeId>()
  const stack = [...(childrenByParent.get(rootId) ?? [])]
  while (stack.length > 0) {
    const n = stack.pop()!
    if (seen.has(n.id)) continue
    seen.add(n.id)
    out.push(n)
    stack.push(...(childrenByParent.get(n.id) ?? []))
  }
  return out
}

/** Settle a parent node's whole SUBTREE — every worker a coordinator spawned this
 *  run, transitively. Used by the per-COORDINATOR gate (a fresh coordinator owns
 *  its whole subtree; the root only ever spawns leads fresh, never resumes them).
 *  Returns the subtree (not just direct children) so `gateOnce`'s `filesChanged`
 *  union sees code written anywhere beneath the coordinator — otherwise a nested
 *  writer looks file-less and the gate judges the deliverable as prose. */
export const settleChildren = (
  conversationId: ConversationId,
  parentNodeId: ContextNodeId,
): Effect.Effect<ReadonlyArray<AgentContextNode>, never, ContextTreeStore> =>
  Effect.gen(function* () {
    let round = 0
    while (true) {
      const all = yield* listTreeSafe(conversationId)
      const subtree = descendantsOf(all, parentNodeId)
      if (
        !subtree.some((n) => n.status === "running") ||
        round >= GATE_SETTLE_MAX_ROUNDS
      ) {
        return subtree
      }
      yield* Clock.sleep("2 seconds")
      round++
    }
  })

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
 *   - `needs_work` under the cap → `retry` with the reasons
 *
 * Pure decision; the caller owns the loop (settle → gateOnce → emit → maybe
 * retry → repeat). Learning is NOT here any more — the turn-boundary distill
 * (`runAutoDistill` in the drivers) is the single distillation per run; the old
 * in-gate distill mined the same conversation a second time.
 */
export const gateOnce = (params: {
  readonly task: string
  readonly summary: string
  readonly repoDir: string
  readonly freshNodes: ReadonlyArray<AgentContextNode>
  readonly attempt: number
  readonly maxAttempts: number
}): Effect.Effect<GateStep, never, Verifier> =>
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

    // Research/prose deliverable (nothing was written): the answer IS the
    // deliverable. A subjective needs_work/blocked is the reviewer's OPINION, not a
    // hard failure like a red typecheck — deliver it WITH the reviewer's notes
    // (advisory), and NEVER retry-to-cap (which re-runs the whole research fleet and
    // can end with nothing delivered). The fail-closed retry loop below is reserved
    // for file-changing (code) deliverables, which genuinely either build or don't.
    // (A coding run that landed NO files is intentionally handled here too: don't
    // re-run a fleet that isn't landing changes — hand back its result + the notes.)
    //
    // BUT advisory only applies when the fleet actually PRODUCED something: a
    // run whose agents mostly errored/were killed and wrote no files is a
    // FAILED fleet, not a prose deliverable — the old code shipped it as
    // "advisory success" (the forensic 13/13-dead run would have gated clean).
    // That stops non-advisory, so the caller's outcome reads partial/failed.
    if (filesChanged.length === 0) {
      const settled = params.freshNodes.filter((n) => n.status !== "running")
      const failed = settled.filter(
        (n) => n.status === "error" || n.status === "killed",
      )
      const fleetFailed = settled.length > 0 && failed.length * 2 > settled.length
      if (fleetFailed) {
        return {
          kind: "stop",
          event: {
            ...event,
            reasons: [
              `the fleet itself failed (${failed.length}/${settled.length} agents ended error/killed) — this is not a deliverable`,
              ...event.reasons,
            ],
          },
        }
      }
      return { kind: "stop", event: { ...event, advisory: true } }
    }

    if (v.verdict === "blocked" || params.attempt >= params.maxAttempts) {
      return { kind: "stop", event }
    }

    // RUN AGAIN — feed the gate's concrete reasons back as the next turn so the
    // swarm fixes them (not a blind re-send), then re-gate. (Learning happens
    // once, at the turn boundary — the drivers' `runAutoDistill` — not here.)
    const feedback: AgentMessage = {
      role: "user",
      content: GATE_FEEDBACK_PREAMBLE + v.reasons.map((r) => `- ${r}`).join("\n"),
    }
    return { kind: "retry", event, feedback }
  })
