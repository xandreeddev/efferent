import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import {
  ConversationMemory,
  Capabilities,
  definePlugin,
  estimateMessageTokens,
  HarnessError,
  MEDIA_LIMITS,
  ledgerOf,
  openLogSession,
  pendingCompaction,
  RECALL_TOOL,
  recallCapabilityOf,
  rewrittenBy,
  scaledTokens,
  spillPreview,
  toolInputOf,
} from "@xandreed/core"
import type { CompactionAction, MemoryPolicy } from "@xandreed/core"

/** @public */
export const MemoryWindowConfig = Schema.Struct({
  /** At turn start, show earlier turns' tool results through their compact views. */
  compactPreviousTurn: Schema.Boolean,
  turnContext: Schema.Literals(["current", "all"]),
  replies: Schema.Boolean,
  /** Results shorter than this are never spilled. */
  spillMinChars: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  previewChars: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  ledgerTurnChars: Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0))),
  /** Digest a result on write once its view reaches this many characters (0: never). */
  digestOnWriteChars: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Show recorded digests in place of the results they digest. */
  digests: Schema.Boolean,
  /**
   * How images reach the model (a user's attachments, the images tool
   * results return): the current turn's are sent as images first, within
   * `maxImages` and `maxMediaChars` (with the defaults a message's own images
   * always fit); `inline` (the default) sends earlier turns' images too,
   * newest turn first, while they fit, `none` shows them as label lines.
   * Text only: `maxMediaChars: 0`.
   */
  media: Schema.Literals(["none", "inline"]),
  /** Images one request sends as images, never more than `MEDIA_LIMITS.requestImages` (and artifact reference lines one result shows). */
  maxImages: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Base64 characters of the images one request sends, at most `MEDIA_LIMITS.requestChars`; 0 sends none (text only). */
  maxMediaChars: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: MEDIA_LIMITS.requestChars }))),
  /**
   * Under budget pressure, keep the current turn's results whole while
   * earlier turns are condensed: drop the oldest turns first, and spill the
   * current turn's largest results only when the current turn alone does not
   * fit. Off (the default), the current turn's results spill before any turn
   * is dropped. On, the strategy's version is `2+current-turn-first`.
   */
  currentTurnFirst: Schema.optionalKey(Schema.Boolean),
})
export type MemoryWindowConfig = typeof MemoryWindowConfig.Type
/** @public */
export const memoryWindowDefaults: MemoryWindowConfig = {
  compactPreviousTurn: true, turnContext: "current", replies: true,
  spillMinChars: 2_000, previewChars: 600, ledgerTurnChars: 240,
  digestOnWriteChars: 0, digests: true, media: "inline", maxImages: MEDIA_LIMITS.requestImages, maxMediaChars: MEDIA_LIMITS.requestChars,
  currentTurnFirst: false,
}

/** @public */
export const WINDOW_STRATEGY = { id: "window", version: "2" } as const

/**
 * The strategy a config runs: always `WINDOW_STRATEGY.id`, so compactions
 * recorded under either order keep applying, with `currentTurnFirst` in the
 * version, so request headers and `context.built` tell the two orders apart.
 */
const strategyOf = (config: MemoryWindowConfig): { readonly id: string; readonly version: string } =>
  config.currentTurnFirst === true ? { id: WINDOW_STRATEGY.id, version: `${WINDOW_STRATEGY.version}+current-turn-first` } : WINDOW_STRATEGY

/**
 * The window policy: compact older turns, spill the current turn's oversized
 * results, then drop the oldest turns; with `currentTurnFirst`, drop the
 * oldest turns before spilling any of the current turn's results.
 *
 * @public
 */
export const windowPolicy = (config: MemoryWindowConfig): MemoryPolicy => ({
  strategy: strategyOf(config),
  render: { turnContext: config.turnContext, replies: config.replies, digests: config.digests, media: { mode: config.media, maxImages: config.maxImages, maxChars: config.maxMediaChars } },
  digestOnWrite: config.digestOnWriteChars === 0 ? Option.none() : Option.some((result) => result.chars >= config.digestOnWriteChars),
  maintain: (input) => decide(config, input).pipe(Effect.map((actions) => ({ actions, digest: [] }))),
})

const decide = (config: MemoryWindowConfig, { entries, signal, turn, render }: Parameters<MemoryPolicy["maintain"]>[0]) => Effect.gen(function* () {
    const strategy = strategyOf(config)
    const rewritten = rewrittenBy(entries, strategy.id)
    const results = entries.flatMap((entry) => entry.body._tag === "ToolResult" ? [{ entry, result: entry.body }] : [])
    const older = signal.phase === "turn-start" && config.compactPreviousTurn
      ? results.filter(({ entry, result }) => entry.turn < turn && !result.pinned && !rewritten.has(entry.id))
      : []
    const compacted = yield* Effect.forEach(older, ({ entry, result }) =>
      signal.views.compact(result.toolName, result.encoded, toolInputOf(entries, entry)).pipe(
        Effect.map((text) => Option.toArray(Option.filter(text, (value) => value !== result.view)).map((value) => ({ id: entry.id, text: value }))),
      ), { concurrency: 1 }).pipe(Effect.map((all) => all.flat()))
    const views: ReadonlyArray<CompactionAction> = compacted.length === 0 ? [] : [{
      _tag: "CompactViews", entries: compacted.map((item) => item.id), texts: compacted.map((item) => item.text),
    }]
    const tokens = (actions: ReadonlyArray<CompactionAction>): number =>
      scaledTokens(estimateMessageTokens(render([...entries, ...actions.map((action, index) => pendingCompaction(strategy, action, index))])), Option.fromNullishOr(signal.observed))
    const over = (actions: ReadonlyArray<CompactionAction>): boolean => tokens(actions) > signal.budgetTokens
    if (!over(views)) return views
    const spills = results
      // A recalled page is never spilled again: it is a bounded part of a result already spilled.
      .filter(({ entry, result }) => entry.turn === turn && !result.pinned && result.toolName !== RECALL_TOOL && !rewritten.has(entry.id) && result.view.length >= config.spillMinChars)
      .sort((left, right) => right.result.view.length - left.result.view.length)
      .map(({ entry, result }): CompactionAction => ({ _tag: "Spill", entry: entry.id, preview: spillPreview(entry, result.view, config.previewChars) }))
    const drops = Array.from({ length: Math.max(0, turn - 1) }, (_, index) => index + 1)
      .map((through): CompactionAction => ({ _tag: "DropTurns", throughTurn: through, ledger: ledgerOf(entries, through, config.ledgerTurnChars) }))
    // Each candidate keeps `base` and drops the oldest turns, one more turn at a time.
    const dropping = (base: ReadonlyArray<CompactionAction>): ReadonlyArray<ReadonlyArray<CompactionAction>> => drops.map((drop) => [...base, drop])
    // The default order spills the current turn's largest results until they fit, then drops the oldest turns.
    const spillFirst = (): Option.Option<ReadonlyArray<CompactionAction>> => {
      const spilled = spills.reduce((actions: ReadonlyArray<CompactionAction>, spill) => !over(actions) ? actions : [...actions, spill], views)
      return !over(spilled) ? Option.some(spilled) : Arr.findFirst(dropping(spilled), (actions) => !over(actions))
    }
    // Current turn first: the fewest spills of the current turn's results, then the fewest dropped turns.
    // Turns are dropped at a spill count only when dropping every earlier turn fits with it.
    const currentFirst = (): Option.Option<ReadonlyArray<CompactionAction>> =>
      Arr.findFirst(Array.from({ length: spills.length + 1 }, (_, count) => [...views, ...spills.slice(0, count)]), (level) => {
        if (!over(level)) return Option.some(level)
        const candidates = dropping(level)
        const deepest = candidates.at(-1)
        return deepest === undefined || over(deepest) ? Option.none() : Arr.findFirst(candidates, (actions) => !over(actions))
      })
    const fitted = config.currentTurnFirst === true ? currentFirst() : spillFirst()
    if (Option.isSome(fitted)) return fitted.value
    // Nothing fits: every spill is in the candidates below, as the default order leaves them.
    const spilled = [...views, ...spills]
    if (signal.phase === "turn-end" || signal.phase === "overflow") return [spilled, ...dropping(spilled)]
      .reduce((best: ReadonlyArray<CompactionAction>, candidate) => tokens(candidate) < tokens(best) ? candidate : best, [])
    return yield* Effect.fail(new HarnessError({ code: "context.budget", message: `The current turn alone exceeds the ${signal.budgetTokens}-token context budget` }))
})

/**
 * The memory-owned tool that makes spills lossless for the model: core's
 * recall capability, contributed under this plugin's id.
 *
 * @public
 */
export const recallCapability = recallCapabilityOf("@xandreed/plugin-memory-window/recall")

/**
 * Windowed conversation memory: every message and tool result is stored at
 * full fidelity; each request shows the current turn verbatim, earlier turns
 * through their tools' compact views, and — only under budget pressure —
 * previews of oversized results and a ledger in place of the oldest turns.
 *
 * @public
 */
export const memoryWindowPlugin = definePlugin({
  id: "@xandreed/plugin-memory-window", version: "0.20.1", scope: "runtime",
  config: MemoryWindowConfig, defaults: memoryWindowDefaults,
  provides: [ConversationMemory],
  contributes: [Capabilities],
  layer: (config) => Layer.mergeAll(
    Layer.sync(ConversationMemory, () => {
      const policy = windowPolicy(config)
      return ConversationMemory.of({
        strategy: policy.strategy,
        open: Effect.fn("memory.open")(({ runId, log }) => openLogSession(log, policy, { runId })),
      })
    }),
    Layer.succeed(Capabilities, [recallCapability]),
  ),
})
/** Windowed memory as a typed layer: provides ConversationMemory and contributes the recall tool. */
export const MemoryWindowLive = memoryWindowPlugin.live
export default memoryWindowPlugin
