import type { Tool, Toolkit } from "@effect/ai"
import { Effect, Option, Ref } from "effect"
import type { LoopEvent } from "../domain/LoopEvent.js"
import type { AgentMessage, ConversationId } from "../domain/Message.js"
import type { TokenUsage } from "../domain/TokenUsage.js"
import { ConversationStore } from "../ports/ConversationStore.js"
import { handoffToMessage, safeKeepFrom } from "./mapping.js"
import { runLoop } from "./loop.js"
import type { CompactionPlan } from "./loop.js"

/**
 * WITHIN-RUN compaction policy: when a finished turn's `inputTokens` exceeds
 * the threshold, the buffer's older turns fold into a summary and the run
 * continues on summary + the last `keepTurns` assistant turns verbatim (the
 * kept tail is ALSO covered by the summary — the overlap that survives a
 * boundary). `summarize` sees the whole buffer; any failure or an empty
 * summary skips the fold (best-effort — the run continues unfolded).
 */
export interface CompactionPolicy {
  readonly thresholdTokens: number
  readonly keepTurns: number
  readonly summarize: (
    transcript: ReadonlyArray<AgentMessage>,
    previous: Option.Option<string>,
  ) => Effect.Effect<string, unknown>
}

/**
 * An agent is a system prompt + a toolkit (+ its loop bounds). The driver
 * decides which config runs; the engine stays agent-agnostic.
 */
export interface AgentConfig<Tools extends Record<string, Tool.Any>> {
  readonly system: string
  readonly toolkit: Toolkit.Toolkit<Tools>
  readonly maxSteps?: number
  readonly pollableTools?: ReadonlyArray<string>
  readonly compaction?: CompactionPolicy
  /** Stream turns (`assistant_delta` events while tokens flow); falls back
   *  to settled turns on a pre-first-part failure. Default false. */
  readonly streaming?: boolean
}

/** Turns to wait after a fold before folding again — anti-thrash. */
const COMPACT_COOLDOWN_TURNS = 3

/**
 * One user turn over a persisted conversation: append the prompt, load the
 * active window (prepending the latest fold's summary when one exists), run
 * the loop with incremental tail persistence, return the result. Store
 * failures are defects (`orDie`) — persistence breaking mid-run is
 * infrastructure death, not a condition the model can correct.
 *
 * With a `compaction` policy, runAgent also owns the store reconciliation
 * for mid-run folds: a POSITION MIRROR tracks each buffer entry's durable
 * position (None for synthetic handoffs), and a fold writes `checkpointAt`
 * on the last covered position — so `listActive` for the NEXT run returns
 * exactly the kept rows and folded events are never resent.
 */
export const runAgent = <Tools extends Record<string, Tool.Any>, R = never>(
  config: AgentConfig<Tools>,
  conversationId: ConversationId,
  prompt: string,
  options?: {
    readonly onEvent?: (event: LoopEvent) => Effect.Effect<void, never, R>
  },
) =>
  Effect.gen(function* () {
    const store = yield* ConversationStore
    const promptPosition = yield* store
      .append(conversationId, { role: "user", content: prompt })
      .pipe(Effect.orDie)
    const fold = yield* store.latestCheckpoint(conversationId).pipe(Effect.orDie)
    const active = yield* store.listActive(conversationId).pipe(Effect.orDie)
    const messages = Option.match(fold, {
      onNone: () => active,
      onSome: (checkpoint) => [handoffToMessage(checkpoint.summary), ...active],
    })

    // Active rows are the contiguous positions ending at the prompt's — the
    // mirror starts aligned with `messages` (None = the synthetic handoff).
    const activePositions = active.map((_, index) =>
      Option.some(promptPosition - active.length + 1 + index),
    )
    const mirrorRef = yield* Ref.make<ReadonlyArray<Option.Option<number>>>(
      Option.isSome(fold) ? [Option.none<number>(), ...activePositions] : activePositions,
    )
    const cooldownRef = yield* Ref.make(0)

    const onTail = (tail: ReadonlyArray<AgentMessage>) =>
      Effect.forEach(tail, (message) => store.append(conversationId, message)).pipe(
        Effect.tap((positions) =>
          Ref.update(mirrorRef, (all) => [...all, ...positions.map(Option.some)]),
        ),
        Effect.orDie,
      )

    const compactWith = (policy: CompactionPolicy) =>
      (buffer: ReadonlyArray<AgentMessage>, lastTurnUsage: TokenUsage) =>
        Effect.gen(function* () {
          const cooldown = yield* Ref.get(cooldownRef)
          if (cooldown > 0) {
            yield* Ref.set(cooldownRef, cooldown - 1)
            return Option.none<CompactionPlan>()
          }
          if (lastTurnUsage.inputTokens <= policy.thresholdTokens) {
            return Option.none<CompactionPlan>()
          }
          const cut = safeKeepFrom(buffer, policy.keepTurns)
          if (Option.isNone(cut)) return Option.none<CompactionPlan>()
          const mirror = yield* Ref.get(mirrorRef)
          // The mirror must still align 1:1 with the loop's buffer, and the
          // covered range must sit strictly below the first kept row — any
          // inconsistency skips the fold rather than corrupting the store.
          if (mirror.length !== buffer.length) return Option.none<CompactionPlan>()
          const covered = mirror.slice(0, cut.value).flatMap(Option.toArray)
          const coveredPosition = covered[covered.length - 1]
          const firstKept = mirror.slice(cut.value).flatMap(Option.toArray)[0]
          if (
            coveredPosition === undefined ||
            (firstKept !== undefined && coveredPosition >= firstKept)
          ) {
            return Option.none<CompactionPlan>()
          }
          const previous = yield* store
            .latestCheckpoint(conversationId)
            .pipe(Effect.map(Option.map((checkpoint) => checkpoint.summary)))
          const summary = (yield* policy.summarize(buffer, previous)).trim()
          if (summary.length === 0) return Option.none<CompactionPlan>()
          yield* store.checkpointAt(conversationId, summary, coveredPosition)
          yield* Ref.set(mirrorRef, [Option.none<number>(), ...mirror.slice(cut.value)])
          yield* Ref.set(cooldownRef, COMPACT_COOLDOWN_TURNS)
          return Option.some<CompactionPlan>({ summary, keepFrom: cut.value })
        }).pipe(
          Effect.withSpan("engine.compact"),
          Effect.catchAll(() => Effect.succeed(Option.none<CompactionPlan>())),
        )

    return yield* runLoop({
      system: config.system,
      messages,
      toolkit: config.toolkit,
      ...(config.maxSteps !== undefined ? { maxSteps: config.maxSteps } : {}),
      ...(config.pollableTools !== undefined ? { pollableTools: config.pollableTools } : {}),
      ...(options?.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
      ...(config.compaction !== undefined ? { compact: compactWith(config.compaction) } : {}),
      ...(config.streaming !== undefined ? { streaming: config.streaming } : {}),
      onTail,
    })
  })
