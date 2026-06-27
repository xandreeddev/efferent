import { Effect } from "effect"
import type { ConversationId } from "../entities/Conversation.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import type { FileSystem } from "../ports/FileSystem.js"
import type { UtilityLlm } from "../ports/UtilityLlm.js"
import type { Verifier } from "../ports/Verifier.js"
import { runDistillation, type DistillResult } from "./distill.js"

/** Minimum messages before a conversation is worth mining — a greeting or a
 *  one-shot Q&A yields nothing reusable. */
export const AUTO_DISTILL_MIN_MESSAGES = 4

/**
 * Fire the self-improving distiller over a just-finished conversation and return
 * the lessons that were actually **persisted** (so the caller can surface them).
 *
 * This is the turn-boundary "learn for next runs" step, factored out so it fires
 * on EVERY run path — the TUI, the daemon, and headless one-shots — not just
 * `efferent code`. That gap is why the loop never closed in practice. Fully
 * fail-soft: a too-short conversation, a missing `claude`/Verifier, or a store
 * error yields an empty list, never an error — learning must never break a run.
 */
export const runAutoDistill = (args: {
  readonly conversationId: ConversationId
  /** Repo dir: the Opus gate runs here AND artifacts land under its `.efferent/`. */
  readonly repoDir: string
  /** Names already known (skills + memory) so the miner doesn't re-propose them. */
  readonly existing: ReadonlyArray<string>
  readonly minMessages?: number
}): Effect.Effect<
  ReadonlyArray<DistillResult>,
  never,
  ConversationStore | UtilityLlm | Verifier | FileSystem
> =>
  Effect.gen(function* () {
    const cs = yield* ConversationStore
    const messages = yield* cs.list(args.conversationId)
    if (messages.length < (args.minMessages ?? AUTO_DISTILL_MIN_MESSAGES)) {
      return [] as ReadonlyArray<DistillResult>
    }
    const results = yield* runDistillation({
      conversationId: args.conversationId,
      messages,
      repoDir: args.repoDir,
      existing: args.existing,
    })
    return results.filter((r) => r.persisted !== undefined)
  }).pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<DistillResult>)))
