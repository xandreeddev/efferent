import { Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { TokenUsage } from "../domain/token-usage.entity.js"
import { EntryId } from "../memory/memory-log.entity.js"

/*
 * What filled the model requests of a session, read back from its journal
 * (`contextReportOf`, the paired functions file): a row per prepared request
 * and a summary per turn. Sizes are characters where the journal holds the
 * text (the system prompt, tool declarations, host context, tool results)
 * and the strategy's token estimate for the messages as a whole, which the
 * journal holds as an estimate only.
 */

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** A text a request carried: its characters, and the tokens the request's reserve counted for it. */
const Sized = Schema.Struct({ characters: Count, tokens: Count })

/**
 * How a request showed a tool result: `whole` is the view it was written
 * with; `compact` its tool's compact view; `digest` a recorded digest;
 * `bounded` a preview recorded as the result was written, so its first
 * request already showed it shortened; `spilled` a preview recorded later,
 * under budget pressure.
 */
const ResultShown = Schema.Literals(["whole", "compact", "digest", "bounded", "spilled"])

/**
 * Where the shown text came from: `tool` is text the tool's own view wrote
 * (its view, its compact view, a digest of it, or a preview cut from its
 * view); `raw` is the result's canonical JSON, whole or cut to a preview,
 * which is what a tool with no view shows.
 */
const ResultView = Schema.Literals(["tool", "raw"])

/** A request's reported usage, and the journal record it was read from. */
export const ContextReportUsage = Schema.Struct({
  source: Schema.Literals(["model.called", "step.usage"]),
  usage: TokenUsage,
})
export type ContextReportUsage = typeof ContextReportUsage.Type

/**
 * One tool result as a request of a turn showed it, at the largest size any
 * request of that turn showed it.
 *
 * @public
 */
export const ContextReportResult = Schema.Struct({
  /** The result's memory entry: the locator `recall_context` reads it by. */
  entry: EntryId,
  tool: Schema.String,
  /** The characters of the result as that request carried it: the shown text with its image labels and artifact lines. */
  characters: Count,
  shown: ResultShown,
  view: ResultView,
  /** The request that showed it at this size, the first one when several did: its run, its step and its resend (`ContextReportRow`). */
  run: RunOrdinal,
  step: Schema.Int,
  resend: Count,
})
export type ContextReportResult = typeof ContextReportResult.Type

/**
 * One prepared model request (a `request.prepared` record) and what filled
 * it. A request sent again in the same step, after the provider refused it
 * for its size or over an image, is a row of its own.
 *
 * @public
 */
export const ContextReportRow = Schema.Struct({
  /** The `request.prepared` the row describes, by its session and sequence number. */
  session: ConversationId,
  seq: Schema.Int,
  turn: Schema.Int,
  runId: RunId,
  run: RunOrdinal,
  step: Schema.Int,
  /** 0 for the step's first prepared request, one up for each request prepared again in that step. */
  resend: Count,
  /** The system text the request carried (the step context included when it rides there, see `contextPlacement`). */
  system: Sized,
  /**
   * The tool declarations the request carried: how many, their characters
   * and tokens, and the largest of them. A declaration counts its description
   * and the canonical JSON of its parameters, each tool's tokens estimated on
   * its own, as the request's reserve counts them.
   */
  tools: Schema.Struct({
    count: Count,
    characters: Count,
    tokens: Count,
    largest: Schema.Array(Schema.Struct({ name: Schema.String, characters: Count, tokens: Count })),
  }),
  /** The tool results the request showed: how many, and their characters as shown. */
  results: Schema.Struct({ count: Count, characters: Count }),
  /**
   * What the `context.built` published for this request measured: the
   * strategy's token estimate of the messages (the journal holds no character
   * count of them), the tokens reserved for the system text and the tool
   * declarations, the budget of the whole request and the compactions the
   * build applied. None when the journal holds no such record for it.
   */
  built: Schema.OptionFromNullOr(Schema.Struct({
    estimatedTokens: Schema.Int,
    reservedTokens: Schema.Int,
    budgetTokens: Schema.Int,
    compactions: Schema.Int,
  })),
  /** The characters of the request hook's note as the model read it (`[Host note: …]`); none when no hook added one. */
  hookNote: Schema.OptionFromNullOr(Count),
  /** The characters of the step policy's own step context the request showed, without the hook's note; none when it showed none. */
  stepContext: Schema.OptionFromNullOr(Count),
  /** Where that host context rode: after the messages (`tail`), or inside the system text (`system`), where `system` already counts it. */
  contextPlacement: Schema.Literals(["tail", "system"]),
  /** The usage the provider reported for this request, and the record it was read from; none for a request that got no accepted response. */
  usage: Schema.OptionFromNullOr(ContextReportUsage),
})
export type ContextReportRow = typeof ContextReportRow.Type

/**
 * One turn's requests in sum: its steps and its requests as two counts (a
 * host-planned step prepares no request, a resend prepares a second one),
 * the largest tool results its requests showed, and what memory recorded
 * during it to shorten what later requests show. `bounds`, `spills`,
 * `compacts` and `digests` count results; `drops` and `summaries` count the
 * times earlier turns were replaced.
 *
 * @public
 */
export const ContextReportTurn = Schema.Struct({
  session: ConversationId,
  turn: Schema.Int,
  /** The steps the turn started (`step.started`). */
  steps: Count,
  /** The requests the turn prepared (`request.prepared`): its rows. */
  requests: Count,
  /**
   * The largest tool results the turn's requests showed, largest first, each
   * once, at the largest size a request of the turn showed it: a result one
   * request showed whole and a later request of the same turn showed through
   * its compact view is listed `whole`, by the request that showed it so,
   * and counted in `compacts`.
   */
  results: Schema.Array(ContextReportResult),
  /** Results shortened as they were written. */
  bounds: Count,
  /** Results shortened later, under budget pressure. */
  spills: Count,
  /** Results given their tool's compact view, at the turn's start or under budget pressure: one for each result a compaction names. */
  compacts: Count,
  /** Times earlier turns were replaced by a ledger. */
  drops: Count,
  /** Times earlier turns were replaced by a summary. */
  summaries: Count,
  /** Tool digests recorded. */
  digests: Count,
})
export type ContextReportTurn = typeof ContextReportTurn.Type

/**
 * What filled the model requests of a session: a row per prepared request,
 * in journal order, and a summary per turn.
 *
 * @public
 */
export const ContextReport = Schema.Struct({
  rows: Schema.Array(ContextReportRow),
  turns: Schema.Array(ContextReportTurn),
})
export type ContextReport = typeof ContextReport.Type
