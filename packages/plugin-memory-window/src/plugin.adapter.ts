import { Array as Arr, Effect, Layer, Option, Schema } from "effect"
import {
  canonicalJson,
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
  scaledTokens,
  shownViewsOf,
  spillPreview,
  toolInputOf,
} from "@xandreed/core"
import type { CompactionAction, EntryId, MemoryPolicy } from "@xandreed/core"

/** @public */
export const MemoryWindowConfig = Schema.Struct({
  /**
   * At turn start, show earlier turns' tool results through their compact
   * views. Off, a turn start rewrites no earlier turn's results, so within a
   * turn each request that fits its budget begins with the messages of the
   * one before it and a provider's cached prefix holds. A turn's first
   * request begins with the previous turn's last one only while everything
   * that request showed is still shown: with `turnContext: "current"` (the
   * default) a turn context the previous turn recorded, such as a turn-tier
   * prompt section, leaves the next turn's requests and the shared prefix
   * ends at that message; with `"all"` it stays. Either way, once a request
   * passes its budget, earlier turns' results take their compact views
   * before anything is spilled or dropped: the fewest that fit, the one whose
   * compact view frees the most of the request's estimate first, and only
   * where it is shorter than the text shown and that estimate falls with it:
   * it must take at least three characters fewer of the message's JSON, so
   * one that takes one or two fewer is left alone. The rule reads a result's
   * text alone: a result that holds images, whose image lines the request
   * shows again after a compact view, can take one although the estimate does
   * not fall.
   */
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
   * earlier turns are condensed: after earlier turns' results have taken
   * their compact views, drop the oldest turns first, and spill the current
   * turn's largest results only when the current turn alone does not fit.
   * Off (the default), the current turn's results spill before any turn is
   * dropped. On, the strategy's version is `4+current-turn-first`.
   */
  currentTurnFirst: Schema.optionalKey(Schema.Boolean),
  /**
   * Bound a result as it is written: a result whose view is longer than this
   * many characters is shown, from the first request that includes it, as
   * its first characters and a notice of how to read the rest with
   * `recall_context`; the stored result stays whole. A tool's own
   * `boundOnWriteChars` annotation replaces this bound for that tool, and
   * `0` there keeps its results whole. Pinned results, recalled pages and
   * results holding images are never bounded. `0` bounds nothing, whatever a
   * tool asks. `windowPolicy` given a config written without the key bounds
   * nothing either; the plugin's options take the default.
   */
  boundOnWriteChars: Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0)))),
})
export type MemoryWindowConfig = typeof MemoryWindowConfig.Type
/** @public */
export const memoryWindowDefaults: MemoryWindowConfig = {
  compactPreviousTurn: true, turnContext: "current", replies: true,
  spillMinChars: 2_000, previewChars: 600, ledgerTurnChars: 240,
  digestOnWriteChars: 0, digests: true, media: "inline", maxImages: MEDIA_LIMITS.requestImages, maxMediaChars: MEDIA_LIMITS.requestChars,
  currentTurnFirst: false, boundOnWriteChars: 16_000,
}

/** @public */
export const WINDOW_STRATEGY = { id: "window", version: "4" } as const

/**
 * The strategy a config runs: always `WINDOW_STRATEGY.id`, so compactions
 * recorded under either order keep applying, with `currentTurnFirst` in the
 * version, so request headers and `context.built` tell the two orders apart.
 */
const strategyOf = (config: MemoryWindowConfig): { readonly id: string; readonly version: string } =>
  config.currentTurnFirst === true ? { id: WINDOW_STRATEGY.id, version: `${WINDOW_STRATEGY.version}+current-turn-first` } : WINDOW_STRATEGY

/**
 * The window policy: bound a result as it is written, compact older turns
 * (at each turn start with `compactPreviousTurn`, and under pressure whatever
 * it says), spill the current turn's oversized results, then drop the oldest
 * turns; with `currentTurnFirst`, drop the oldest turns before spilling any
 * of the current turn's results. A decision that drops a turn records no
 * compact view of that turn's results.
 *
 * @public
 */
export const windowPolicy = (config: MemoryWindowConfig): MemoryPolicy => ({
  strategy: strategyOf(config),
  render: { turnContext: config.turnContext, replies: config.replies, digests: config.digests, media: { mode: config.media, maxImages: config.maxImages, maxChars: config.maxMediaChars } },
  digestOnWrite: config.digestOnWriteChars === 0 ? Option.none() : Option.some((result) => result.chars >= config.digestOnWriteChars),
  // A config written before the option has no key: given to the policy as it is, it bounds nothing.
  ...(config.boundOnWriteChars === undefined || config.boundOnWriteChars === 0 ? {} : { boundOnWriteChars: config.boundOnWriteChars }),
  maintain: (input) => decide(config, input).pipe(Effect.map((actions) => ({ actions, digest: [] }))),
})

/** The characters of a message's JSON that core's estimate counts as one token (`estimateMessageTokens`). */
const TOKEN_CHARS = 3

/**
 * What a text takes of a request's estimate, in characters: the estimate
 * counts each message as its JSON, where a quote, a backslash, a newline or
 * another control character takes more than one.
 */
const weightOf = (text: string): number => canonicalJson(text).length

const decide = (config: MemoryWindowConfig, { entries, signal, turn, render }: Parameters<MemoryPolicy["maintain"]>[0]) => Effect.gen(function* () {
    const strategy = strategyOf(config)
    // What each result shows where that is not its view: a compact view, the preview of a spill or of a bound, a digest.
    const shownViews = shownViewsOf(entries, { strategy: strategy.id, digests: config.digests })
    const results = entries.flatMap((entry) => {
      const result = entry.body
      if (result._tag !== "ToolResult") return []
      const shown = Option.fromNullishOr(shownViews.get(entry.id))
      // `text` is what the result shows now, its view unless other text is shown in its place, and `showing` its length.
      const text = Option.match(shown, { onNone: () => result.view, onSome: (now) => now.text })
      return [{ entry, result, shown, text, showing: text.length }]
    })
    // A turn this strategy has dropped shows none of its results: a compact view of one would free nothing, and the journal would keep text no request shows.
    const droppedThrough = entries.reduce((through, entry) =>
      entry.body._tag === "Compaction" && entry.body.strategy === strategy.id && entry.body.action._tag === "DropTurns" ? Math.max(through, entry.body.action.throughTurn) : through, 0)
    // The results that may still take a compact view: an earlier turn's that is still shown, never the current turn's, a pinned one or one that already shows its compact view.
    const earlier = results.filter(({ entry, result, shown }) =>
      entry.turn < turn && entry.turn > droppedThrough && !result.pinned && !Option.exists(shown, (now) => now.by === "CompactViews"))
    const compactOf = ({ entry, result }: typeof results[number]) => signal.views.compact(result.toolName, result.encoded, toolInputOf(entries, entry))
    const compactViews = (items: ReadonlyArray<{ readonly id: EntryId; readonly text: string }>): ReadonlyArray<CompactionAction> =>
      items.length === 0 ? [] : [{ _tag: "CompactViews", entries: items.map((item) => item.id), texts: items.map((item) => item.text) }]
    // A turn the decision drops shows none of its results either, so their compact views are left out of it: the request is the
    // same without them. A compact view left with no result is not recorded at all.
    const withoutDropped = (actions: ReadonlyArray<CompactionAction>): ReadonlyArray<CompactionAction> => {
      const through = actions.reduce((dropped, action) => action._tag === "DropTurns" ? Math.max(dropped, action.throughTurn) : dropped, 0)
      const hidden = new Set(results.flatMap(({ entry }) => entry.turn <= through ? [entry.id] : []))
      return actions.flatMap((action): ReadonlyArray<CompactionAction> => action._tag !== "CompactViews" ? [action]
        : compactViews(action.entries.flatMap((id, index) => hidden.has(id) ? [] : [{ id, text: action.texts[index] ?? "" }])))
    }
    // With `compactPreviousTurn`, a turn start compacts every earlier turn, whatever the budget.
    // A result takes its compact view once. One shown through a preview is asked again, and takes it only when it is shorter than that preview.
    const atTurnStart = signal.phase === "turn-start" && config.compactPreviousTurn
    const compacted = yield* Effect.forEach(atTurnStart ? earlier : [], (item) =>
      compactOf(item).pipe(
        Effect.map((text) => Option.toArray(Option.filter(text, (value) => Option.match(Option.filter(item.shown, (now) => now.by === "Spill"), {
          onNone: () => value !== item.result.view,
          onSome: (preview) => value.length < preview.text.length,
        }))).map((value) => ({ id: item.entry.id, text: value }))),
      ), { concurrency: 1 }).pipe(Effect.map((all) => all.flat()))
    const atStart = compactViews(compacted)
    const tokens = (actions: ReadonlyArray<CompactionAction>): number =>
      scaledTokens(estimateMessageTokens(render([...entries, ...actions.map((action, index) => pendingCompaction(strategy, action, index))])), Option.fromNullishOr(signal.observed))
    const over = (actions: ReadonlyArray<CompactionAction>): boolean => tokens(actions) > signal.budgetTokens
    // Within the budget nothing more is decided and no compact view is asked for: without `compactPreviousTurn`, a request that fits is never rewritten.
    if (!over(atStart)) return atStart
    // Over the budget, earlier turns' results take their compact views before anything is spilled or dropped, whatever `compactPreviousTurn`
    // says: a compact view takes less from the model than a preview or a ledger. A turn start that compacted has asked every one of them above.
    const lighter = yield* Effect.forEach(atTurnStart ? [] : earlier, (item) =>
      compactOf(item).pipe(
        // A compact view is taken only when it is strictly shorter than the text shown (a bounded, spilled or digested result may already
        // show less) and the request's estimate falls with it. The budget is counted in the estimate, which reads a text as it stands in
        // its message's JSON, so the saving is measured there. A saving of at least a token lowers the estimate whatever else the message
        // holds and whichever other compact views are taken; a shorter text full of quotes or newlines, which would raise it, has none.
        // The result's text alone is read: where it holds images, the renders below count what else the request carries of it.
        Effect.map((text) => Option.toArray(Option.filter(text, (value) => value.length < item.showing))
          .map((value) => ({ id: item.entry.id, text: value, saved: weightOf(item.text) - weightOf(value) }))
          .filter((candidate) => candidate.saved >= TOKEN_CHARS)),
      ), { concurrency: 1 }).pipe(Effect.map((all) => all.flat()))
    // The compact view that frees the most of the estimate goes first; equal savings keep the order of the log.
    const bySaving = lighter.toSorted((left, right) => right.saved - left.saved)
    const compacting = (count: number): ReadonlyArray<CompactionAction> => [...atStart, ...compactViews(bySaving.slice(0, count))]
    // The fewest compact views that fit, found by halving so the renders stay logarithmic in the earlier results: `enough` of them fit and `few` do not.
    const fewest = (few: number, enough: number): number => {
      if (enough - few <= 1) return enough
      const middle = Math.floor((few + enough) / 2)
      return over(compacting(middle)) ? fewest(middle, enough) : fewest(few, middle)
    }
    // When every compact view together does not fit, all of them are taken and the stages below start from there.
    const views = compacting(bySaving.length)
    if (bySaving.length > 0 && !over(views)) return compacting(fewest(0, bySaving.length))
    const spills = results
      // A recalled page is never spilled again: it is a bounded part of a result already spilled.
      .filter(({ entry, result }) => entry.turn === turn && !result.pinned && result.toolName !== RECALL_TOOL && result.view.length >= config.spillMinChars)
      .flatMap(({ entry, result, shown, showing }) => {
        const preview = spillPreview(entry, result.view, config.previewChars)
        // A result shown through other text (a bound's preview, an earlier spill's, a digest) is spilled only when this preview is shorter than that text.
        return Option.isSome(shown) && preview.length >= showing ? [] : [{ showing, action: { _tag: "Spill", entry: entry.id, preview } satisfies CompactionAction }]
      })
      // The largest text shown goes first: a bounded result counts as its preview, not as the whole view behind it.
      .sort((left, right) => right.showing - left.showing)
      .map((spill): CompactionAction => spill.action)
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
    if (Option.isSome(fitted)) return withoutDropped(fitted.value)
    // Nothing fits: every spill is in the candidates below, as the default order leaves them.
    const spilled = [...views, ...spills]
    if (signal.phase === "turn-end" || signal.phase === "overflow") return withoutDropped([spilled, ...dropping(spilled)]
      .reduce((best: ReadonlyArray<CompactionAction>, candidate) => tokens(candidate) < tokens(best) ? candidate : best, []))
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
  id: "@xandreed/plugin-memory-window", version: "0.21.1", scope: "runtime",
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
