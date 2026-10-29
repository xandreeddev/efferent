import { Effect, Layer, Option, Schema } from "effect"
import {
  ConversationMemory,
  definePlugin,
  digestTranscript,
  estimateMessageTokens,
  HarnessError,
  MEDIA_LIMITS,
  openLogSession,
  UtilityLlm,
} from "@xandreed/core"
import type { AgentMessage, CompactionAction, LogEntry, MemoryPolicy } from "@xandreed/core"

export const MemorySummaryConfig = Schema.Struct({
  /** Summarize once the rendered messages pass this share of the budget. */
  triggerRatio: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0.1, maximum: 1 }))),
  /** Keep at least this share of the budget verbatim (the newest turns). */
  keepRatio: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0.05, maximum: 0.9 }))),
  /** Turns between two summaries (a summary is not revisited every step). */
  cooldownTurns: Schema.Int.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  turnContext: Schema.Literals(["current", "all"]),
  replies: Schema.Boolean,
  /** Show recorded tool digests in place of the results they digest. */
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
  /** Instructions for the summarizer; the transcript and any earlier summary follow. */
  instructions: Schema.String,
})
export type MemorySummaryConfig = typeof MemorySummaryConfig.Type
export const memorySummaryDefaults: MemorySummaryConfig = {
  triggerRatio: 0.8, keepRatio: 0.16, cooldownTurns: 3, turnContext: "current", replies: true, digests: true, media: "inline",
  maxImages: MEDIA_LIMITS.requestImages, maxMediaChars: MEDIA_LIMITS.requestChars,
  instructions: "Summarize the earlier part of this conversation for the same assistant, which will continue from your summary plus the newest turns. Preserve, in order: the user's goals and constraints; facts and records established (with their identifiers); answers already given; open questions and pending work. Dense prose and lists; never invent anything not in the transcript.",
}

export const SUMMARY_STRATEGY = { id: "summary", version: "1" } as const

const latestSummary = (entries: ReadonlyArray<LogEntry>) => Option.fromNullishOr(entries.flatMap((entry) =>
  entry.body._tag === "Compaction" && entry.body.strategy === SUMMARY_STRATEGY.id && entry.body.action._tag === "Summarize"
    ? [{ turn: entry.turn, keepFromTurn: entry.body.action.keepFromTurn, summary: entry.body.action.summary }] : []).at(-1))

/** The newest turn whose verbatim tail still fits the kept share of the budget. */
const keepFrom = (entries: ReadonlyArray<LogEntry>, turn: number, keepTokens: number, render: (entries: ReadonlyArray<LogEntry>) => ReadonlyArray<AgentMessage>): number =>
  Array.from({ length: turn }, (_, index) => turn - index)
    .reduce((kept, candidate) => {
      const tail = entries.filter((entry) => entry.turn >= candidate)
      return estimateMessageTokens(render(tail)) <= keepTokens ? candidate : kept
    }, turn)

/**
 * Summarizing conversation memory: the same full-fidelity log and render as
 * the window strategy, but when context grows past the trigger the oldest
 * turns are folded into one recorded summary (previous summary included).
 */
export const summaryPolicy = (config: MemorySummaryConfig, summarize: (prompt: string) => Effect.Effect<string, HarnessError>): MemoryPolicy => ({
  strategy: SUMMARY_STRATEGY,
  render: { turnContext: config.turnContext, replies: config.replies, digests: config.digests, media: { mode: config.media, maxImages: config.maxImages, maxChars: config.maxMediaChars } },
  digestOnWrite: Option.none(),
  maintain: (input) => decide(config, summarize, input).pipe(Effect.map((actions) => ({ actions, digest: [] }))),
})

const decide = (
  config: MemorySummaryConfig,
  summarize: (prompt: string) => Effect.Effect<string, HarnessError>,
  { entries, signal, turn, render }: Parameters<MemoryPolicy["maintain"]>[0],
): Effect.Effect<ReadonlyArray<CompactionAction>, HarnessError> => Effect.gen(function* () {
    const tokens = estimateMessageTokens(render(entries))
    const previous = latestSummary(entries)
    const cooling = Option.match(previous, { onNone: () => false, onSome: (prior) => turn - prior.turn < config.cooldownTurns })
    if (tokens <= signal.budgetTokens * config.triggerRatio || cooling) return []
    const from = keepFrom(entries, turn, signal.budgetTokens * config.keepRatio, render)
    const priorKeep = Option.match(previous, { onNone: () => 1, onSome: (prior) => prior.keepFromTurn })
    if (from <= priorKeep) return []
    const folded = entries.filter((entry) => entry.turn >= priorKeep && entry.turn < from)
    const transcript = digestTranscript(folded, { result: 240, total: 120_000 })
    const summary = (yield* summarize(`${config.instructions}${Option.match(previous, {
      onNone: () => "",
      onSome: (prior) => `\n\nAn earlier summary already covers the oldest turns — fold its facts in:\n${prior.summary}`,
    })}\n\nTRANSCRIPT:\n${transcript}`)).trim()
    const action: CompactionAction = { _tag: "Summarize", keepFromTurn: from, summary }
    return summary.length === 0 ? [] : [action]
})

const missingUtility = new HarnessError({ code: "memory.summary", message: "The summary strategy needs a UtilityLlm in the turn's services" })

/** The summarizer is the UtilityLlm of where each session is opened (the turn), so it runs under that turn's budget. */
export const memorySummaryPlugin = definePlugin({
  id: "@xandreed/plugin-memory-summary", version: "0.13.0", scope: "runtime",
  config: MemorySummaryConfig, defaults: memorySummaryDefaults,
  provides: [ConversationMemory],
  layer: (config) => Layer.succeed(ConversationMemory, ConversationMemory.of({
      strategy: SUMMARY_STRATEGY,
      open: ({ runId, log }) => Effect.gen(function* () {
        const utility = yield* Effect.serviceOption(UtilityLlm).pipe(Effect.flatMap(Option.match({ onNone: () => Effect.fail(missingUtility), onSome: Effect.succeed })))
        const policy = summaryPolicy(config, (prompt) => utility.complete(prompt).pipe(
          Effect.map((completion) => completion.text),
          Effect.mapError((error) => new HarnessError({ code: "memory.summary", message: error.message })),
        ))
        return yield* openLogSession(log, policy, { runId })
      }),
    })),
})
/** Summarizing memory as a typed layer: provides ConversationMemory (and needs a UtilityLlm per turn). */
export const MemorySummaryLive = memorySummaryPlugin.live
export default memorySummaryPlugin
