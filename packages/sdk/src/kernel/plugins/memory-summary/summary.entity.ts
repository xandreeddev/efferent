import { Schema } from "effect"
import { Seq, storedEvent } from "@xandreed/core/kernel"
import type { PointerOptions } from "../../contracts/memory/pointer.entity.js"

/**
 * How the summary memory is set up.
 *
 * @public
 */
export interface SummaryOptions {
  /** What the history may cost, the system text left out (the caller's), by memory's estimate (`estimateTokens`). */
  readonly budgetTokens: number
  /**
   * How many of the latest closed turns it would rather keep whole when it must fold: a preference, not a floor.
   * When keeping them would still be over the budget, they are folded too. 1 when left out.
   */
  readonly keepTurns?: number
  /**
   * Send long tool results as pointers (`pointed`): the budget then counts what is sent, and the summarizer is
   * handed what the model was. Left out, every result is sent whole.
   */
  readonly pointers?: PointerOptions
}

/**
 * The data of `plugin.summary.summarized`: every message of the conversation at or before `through` is replaced, in
 * every later context, by this record's summary, which is the text of its message (a host note).
 *
 * @public
 */
export const SummarizedData = Schema.Struct({ through: Seq })
export type SummarizedData = typeof SummarizedData.Type

/**
 * `plugin.summary.summarized`: old turns folded into a summary. Stored once, tagged `memory`; the summary is the
 * record's message. A reader of this memory's records that does not know it may not skip it: the context depends on it.
 *
 * @public
 */
export const summarizedEvent = storedEvent("summary", "summarized", { data: SummarizedData, skippable: false, tags: ["memory"] })
