import { Tool } from "@effect/ai"
import { Effect, Layer, Option, Schema } from "effect"
import {
  ConversationMemory,
  Contributions,
  defineContributions,
  defineSkill,
  defineTool,
  definePlugin,
  EntryId,
  estimateMessageTokens,
  Failure,
  HarnessError,
  ledgerOf,
  MemoryLog,
  openLogSession,
  pendingCompaction,
  rewrittenBy,
  RunContext,
  toolInputsOf,
} from "@xandreed/core"
import type { CompactionAction, LogEntry, MemoryPolicy } from "@xandreed/core"

const Config = Schema.Struct({
  /** At turn start, show earlier turns' tool results through their compact views. */
  compactPreviousTurn: Schema.Boolean,
  turnContext: Schema.Literal("current", "all"),
  replies: Schema.Boolean,
  /** Results shorter than this are never spilled. */
  spillMinChars: Schema.Int.pipe(Schema.positive()),
  previewChars: Schema.Int.pipe(Schema.positive()),
  ledgerTurnChars: Schema.Int.pipe(Schema.positive()),
  /** Digest a result on write once its view reaches this many characters (0: never). */
  digestOnWriteChars: Schema.Int.pipe(Schema.nonNegative()),
  /** Show recorded digests in place of the results they digest. */
  digests: Schema.Boolean,
  media: Schema.Literal("none", "inline"),
  maxImages: Schema.Int.pipe(Schema.nonNegative()),
})
type Config = typeof Config.Type
const defaults: Config = {
  compactPreviousTurn: true, turnContext: "current", replies: true,
  spillMinChars: 2_000, previewChars: 600, ledgerTurnChars: 240,
  digestOnWriteChars: 0, digests: true, media: "none", maxImages: 8,
}

export const WINDOW_STRATEGY = { id: "window", version: "1" } as const

const preview = (entry: LogEntry, view: string, chars: number): string =>
  `${view.slice(0, chars)}\n[… ${view.length - chars} more characters kept out of context; call recall_context with locator "${entry.id}" for the full result]`

/** The window policy: compact older turns, spill oversized results, then drop the oldest turns. */
export const windowPolicy = (config: Config): MemoryPolicy => ({
  strategy: WINDOW_STRATEGY,
  render: { turnContext: config.turnContext, replies: config.replies, digests: config.digests, media: { mode: config.media, maxImages: config.maxImages } },
  digestOnWrite: config.digestOnWriteChars === 0 ? Option.none() : Option.some((result) => result.chars >= config.digestOnWriteChars),
  maintain: (input) => decide(config, input).pipe(Effect.map((actions) => ({ actions, digest: [] }))),
})

const decide = (config: Config, { entries, signal, turn, render }: Parameters<MemoryPolicy["maintain"]>[0]) => Effect.gen(function* () {
    const rewritten = rewrittenBy(entries, WINDOW_STRATEGY.id)
    const inputs = toolInputsOf(entries, [])
    const results = entries.flatMap((entry) => entry.body._tag === "ToolResult" ? [{ entry, result: entry.body }] : [])
    const older = signal.phase === "turn-start" && config.compactPreviousTurn
      ? results.filter(({ entry, result }) => entry.turn < turn && !result.pinned && !rewritten.has(entry.id))
      : []
    const compacted = yield* Effect.forEach(older, ({ entry, result }) =>
      signal.views.compact(result.toolName, result.encoded, inputs.get(String(result.toolCallId)) ?? {}).pipe(
        Effect.map((text) => Option.toArray(Option.filter(text, (value) => value !== result.view)).map((value) => ({ id: entry.id, text: value }))),
      )).pipe(Effect.map((all) => all.flat()))
    const views: ReadonlyArray<CompactionAction> = compacted.length === 0 ? [] : [{
      _tag: "CompactViews", entries: compacted.map((item) => item.id), texts: compacted.map((item) => item.text),
    }]
    const over = (actions: ReadonlyArray<CompactionAction>): boolean =>
      estimateMessageTokens(render([...entries, ...actions.map((action, index) => pendingCompaction(WINDOW_STRATEGY, action, index))])) > signal.budgetTokens
    if (!over(views)) return views
    const spillable = results
      .filter(({ entry, result }) => entry.turn === turn && !result.pinned && !rewritten.has(entry.id) && result.view.length >= config.spillMinChars)
      .sort((left, right) => right.result.view.length - left.result.view.length)
    const spilled = spillable.reduce((actions: ReadonlyArray<CompactionAction>, { entry, result }): ReadonlyArray<CompactionAction> => !over(actions) ? actions
      : [...actions, { _tag: "Spill", entry: entry.id, preview: preview(entry, result.view, config.previewChars) }], views)
    if (!over(spilled)) return spilled
    const dropped = Array.from({ length: Math.max(0, turn - 1) }, (_, index) => index + 1)
      .map((through): ReadonlyArray<CompactionAction> => [...spilled, { _tag: "DropTurns", throughTurn: through, ledger: ledgerOf(entries, through, config.ledgerTurnChars) }])
      .find((actions) => !over(actions))
    if (dropped !== undefined) return dropped
    return yield* Effect.fail(new HarnessError({ code: "context.budget", message: `The current turn alone exceeds the ${signal.budgetTokens}-token context budget` }))
})

const RecallContext = Tool.make("recall_context", {
  description: "Read the full text of an earlier result that was shortened to save context. Pass the locator shown in the shortened result.",
  parameters: { locator: Schema.String },
  success: Schema.String,
  failure: Failure,
  failureMode: "return",
})

/** The memory-owned tool that makes spills lossless for the model. */
export const recallContribution = defineContributions({
  id: "@xandreed/plugin-memory-window/recall",
  version: "1",
  tools: [defineTool({
    tool: RecallContext,
    handler: ({ locator }) => Effect.gen(function* () {
      const run = yield* RunContext
      const id = Schema.decodeUnknownOption(EntryId)(locator)
      const entry = Option.isNone(id) ? Option.none<LogEntry>() : yield* run.memory.resolve(id.value)
      return yield* Option.match(Option.filter(entry, (found) => found.body._tag === "ToolResult"), {
        onNone: () => Effect.fail({ error: "UnknownLocator", message: `No stored result has locator ${locator}` }),
        onSome: (found) => Effect.succeed(found.body._tag === "ToolResult" ? found.body.view : ""),
      })
    }),
    annotations: { readOnly: true },
  })],
  skills: [defineSkill({ id: "memory.recall", summary: "Read shortened earlier results in full.", tools: ["recall_context"], always: true })],
})

/**
 * Windowed conversation memory: every message and tool result is stored at
 * full fidelity; each request shows the current turn verbatim, earlier turns
 * through their tools' compact views, and — only under budget pressure —
 * previews of oversized results and a ledger in place of the oldest turns.
 */
export const memoryWindowPlugin = definePlugin({
  id: "@xandreed/plugin-memory-window", version: "0.6.0-next.1", scope: "runtime",
  config: Config, defaults,
  requires: [MemoryLog],
  provides: [ConversationMemory],
  contributes: [Contributions],
  layer: (config) => Layer.mergeAll(
    Layer.effect(ConversationMemory, Effect.gen(function* () {
      const log = yield* MemoryLog
      const policy = windowPolicy(config)
      return ConversationMemory.of({
        strategy: WINDOW_STRATEGY,
        open: ({ conversation, runId, io, services }) => log.open(conversation, io).pipe(Effect.flatMap((handle) => openLogSession(handle, policy, { runId, services }))),
      })
    })),
    Layer.succeed(Contributions, [recallContribution]),
  ),
})
export default memoryWindowPlugin
