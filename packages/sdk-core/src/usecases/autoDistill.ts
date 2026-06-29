import { Effect } from "effect"
import type { ConversationId } from "../entities/Conversation.js"
import { ContextTreeStore } from "../ports/ContextTreeStore.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import type { FileSystem } from "../ports/FileSystem.js"
import type { UtilityLlm } from "../ports/UtilityLlm.js"
import type { Verifier } from "../ports/Verifier.js"
import { runDistillation, type DistillResult } from "./distill.js"
import { efficiencyGate } from "./efficiencyGate.js"
import { persistArtifact } from "./persistArtifact.js"

/** Minimum messages before a conversation is worth mining — a greeting or a
 *  one-shot Q&A yields nothing reusable. */
export const AUTO_DISTILL_MIN_MESSAGES = 4

/** Cooldown between distillations on the SAME conversation — prevents a tight
 *  loop (e.g. gate-driven retry) from mining the same half-dozen messages
 *  repeatedly. 5 minutes is long enough that a retry's new tail matters. */
const DISTILL_COOLDOWN_MS = 5 * 60 * 1000

const lastDistilled = new Map<ConversationId, number>()

const isOnCooldown = (cid: ConversationId): boolean => {
  const t = lastDistilled.get(cid)
  return t !== undefined && Date.now() - t < DISTILL_COOLDOWN_MS
}

/**
 * Fire the self-improving distiller over a just-finished conversation and return
 * the lessons that were actually **persisted** (so the caller can surface them).
 *
 * Two learning sources, both folded in so every run path gets both:
 * 1. **Deterministic fleet-efficiency gate** ({@link efficiencyGate}) — no LLM,
 *    always runs: if the fleet over-worked the run it persists a `research-budget`
 *    constraint the next run inherits. Trustworthy by construction → no gate.
 * 2. **LLM distiller** ({@link runDistillation}) — Reflector mines candidates,
 *    the Opus gate refutes each, the Curator persists survivors. Gated on a
 *    minimum conversation length and on `claude` being present (fail-closed).
 *
 * Factored out so it fires on EVERY run path — TUI, daemon, and headless — not
 * just `efferent code`; that gap is why the loop never closed in practice. Fully
 * fail-soft: a too-short conversation, a missing `claude`/Verifier, or a store
 * error yields an empty list, never an error — learning must never break a run.
 */
export const runAutoDistill = (args: {
  readonly conversationId: ConversationId
  /** Repo dir: the Opus gate runs here AND `project`-scoped artifacts land under its `.efferent/`. */
  readonly repoDir: string
  /** Global root (`~`): `global`-scoped learnings land under ITS `.efferent/`, loaded
   *  into every workspace (general rules — Effect/style/language). Omit ⇒ all local. */
  readonly globalDir?: string
  /** Names already known (skills + memory) so the miner doesn't re-propose them. */
  readonly existing: ReadonlyArray<string>
  readonly minMessages?: number
}): Effect.Effect<
  ReadonlyArray<DistillResult>,
  never,
  ConversationStore | ContextTreeStore | UtilityLlm | Verifier | FileSystem
> =>
  Effect.gen(function* () {
    if (isOnCooldown(args.conversationId)) return [] as ReadonlyArray<DistillResult>

    const out: DistillResult[] = []

    // (1) Deterministic efficiency gate — always, no LLM, no Verifier. Its constraint
    // is project-scoped (about THIS run's fleet), so it stays local.
    const effCandidate = yield* efficiencyGate(args.conversationId)
    if (effCandidate !== null) {
      const persisted = yield* persistArtifact(
        args.repoDir,
        effCandidate,
        undefined,
        args.globalDir,
      ).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
      if (persisted !== undefined) {
        out.push({
          candidate: effCandidate,
          verdict: { accept: true, score: 1, reason: "deterministic fleet-efficiency gate" },
          accepted: true,
          persisted,
        })
      }
    }

    // (2) LLM distiller — gated on conversation length; fail-closed at the Opus gate
    // (except user-stated rules, which bypass it — see runDistillation).
    const cs = yield* ConversationStore
    const messages = yield* cs.list(args.conversationId)
    if (messages.length >= (args.minMessages ?? AUTO_DISTILL_MIN_MESSAGES)) {
      const results = yield* runDistillation({
        conversationId: args.conversationId,
        messages,
        repoDir: args.repoDir,
        ...(args.globalDir !== undefined ? { globalDir: args.globalDir } : {}),
        existing: args.existing,
      })
      out.push(...results.filter((r) => r.persisted !== undefined))
    }

    if (out.length > 0) {
      lastDistilled.set(args.conversationId, Date.now())
    }
    return out as ReadonlyArray<DistillResult>
  }).pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<DistillResult>)))
