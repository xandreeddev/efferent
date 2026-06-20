import { Effect } from "effect"
import type { TokenUsage } from "../ports/LlmInfo.js"
import type { AgentMessage } from "./Conversation.js"

/**
 * **Context compression** — the seam by which an agent customizes how its
 * context is kept small. The SDK still *provides* the compaction tactics (see
 * `usecases/compaction.ts` → `Compaction`), but which (if any) run is a property of
 * the agent (`AgentConfig.compression`), not a hardcoded step in the loop.
 *
 * Two moments, deliberately distinct:
 *
 * - {@link TailCompressor} — **append-time**, per tool-result. Runs once as a
 *   step's new tail enters the buffer; the compressed form is what gets
 *   persisted. MUST be deterministic and only touch the new tail — the
 *   provider prompt cache keys on a byte-stable prefix, so rewriting history
 *   would blow the cache.
 * - {@link ContextCompressor} — **in-memory**, per-turn. Transforms the whole
 *   buffer before a turn's prompt is built; never persisted. Active context
 *   rewriting trades cache hits for compaction, so the default is identity (off).
 *
 * Strategies are `R = never`: a custom one reaches services it needs via
 * `Effect.serviceOption(Tag)` (found iff provided at the composition root, like
 * `UtilityLlm` in compaction) or by closing over a pre-built client — so
 * `AgentConfig` never needs a requirements type parameter.
 */

/** What a compressor is allowed to know about the run when deciding what to drop. */
export interface CompressionBudget {
  /** Per-string char budget for a tool result (≈ `Settings.toolResultMaxTokens` × 4). */
  readonly maxChars: number
  /** The model's context window, when known — for context-window-aware strategies. */
  readonly contextWindow?: number
  /** The last turn's input tokens, when known. */
  readonly inputTokens?: number
}

/** What one tail pass did — the (possibly compressed) tail + any helper-tier spend. */
export interface CompressionReport {
  readonly messages: ReadonlyArray<AgentMessage>
  /** FAST-tier usage from middle summaries (absent when none ran) — re-emitted by
   *  the loop via `onHelperUsage` so the ledger counts it. */
  readonly helperUsage?: TokenUsage
}

/** Moment 1: compress a step's new tail as it enters the buffer (persisted-compressed). */
export type TailCompressor = (
  tail: ReadonlyArray<AgentMessage>,
  budget: CompressionBudget,
) => Effect.Effect<CompressionReport>

/** Moment 2: transform the in-memory buffer before a turn's prompt (not persisted). */
export type ContextCompressor = (
  messages: ReadonlyArray<AgentMessage>,
) => Effect.Effect<ReadonlyArray<AgentMessage>>

/** An agent's compression policy. Either field absent ⇒ that moment is a passthrough. */
export interface CompressionPolicy {
  readonly tail?: TailCompressor
  readonly context?: ContextCompressor
}

/** Add two optional usages — `undefined` is the identity. Shared with compaction. */
export const sumUsage = (
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage | undefined =>
  a === undefined
    ? b
    : b === undefined
      ? a
      : {
          inputTokens: a.inputTokens + b.inputTokens,
          outputTokens: a.outputTokens + b.outputTokens,
          totalTokens: a.totalTokens + b.totalTokens,
          cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
        }

/** A tail compressor that changes nothing — the explicit "no compression" value. */
const passthroughTail: TailCompressor = (messages) => Effect.succeed({ messages })

/**
 * Strategy-level combinators — compose/branch whole {@link TailCompressor}s.
 * (The compaction *tactics* live in `Compaction`; these are the generic glue.)
 */
export const Compression = {
  /** Disable compression entirely (passthrough tail, identity context). */
  none: { tail: passthroughTail } as CompressionPolicy,

  /** The passthrough tail compressor, exposed for explicit composition/fallback. */
  passthroughTail,

  /**
   * Run tail compressors in sequence, feeding each one's output to the next and
   * summing their helper usage. `pipeline()` (no steps) is a passthrough.
   */
  pipeline:
    (...steps: ReadonlyArray<TailCompressor>): TailCompressor =>
    (tail, budget) =>
      Effect.gen(function* () {
        let messages: ReadonlyArray<AgentMessage> = tail
        let helperUsage: TokenUsage | undefined
        for (const step of steps) {
          const report = yield* step(messages, budget)
          messages = report.messages
          helperUsage = sumUsage(helperUsage, report.helperUsage)
        }
        return helperUsage !== undefined ? { messages, helperUsage } : { messages }
      }),

  /** Apply `step` only when `pred(budget)` holds; otherwise pass the tail through. */
  when:
    (
      pred: (budget: CompressionBudget) => boolean,
      step: TailCompressor,
    ): TailCompressor =>
    (tail, budget) =>
      pred(budget) ? step(tail, budget) : Effect.succeed({ messages: tail }),
}
