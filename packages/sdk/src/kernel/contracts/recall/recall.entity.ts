import { Schema } from "effect"
import type { Effect } from "effect"
import { liveEvent } from "@xandreed/core/kernel"
import type { PluginFailure } from "@xandreed/core/kernel"
import { FACT_LIMIT, FactId } from "../facts/facts.entity.js"
import type { Fact } from "../facts/facts.entity.js"
import { LinkId } from "../graph/graph.entity.js"
import type { SaidLink } from "../graph/graph.entity.js"
import { KEY_LIMIT } from "../vector-store/vector-store.entity.js"

/**
 * What an agent knows that can be recalled by meaning (ADR 0021, amended): a link that stands, with how often and when
 * it was said (`SaidLink`), or a fact that stands, with when its record was stored (`at`, in milliseconds). Each is
 * read from its own journal, never from the store of vectors; its text is `recallText`.
 *
 * @public
 */
export type RecallItem =
  | { readonly _tag: "Link"; readonly said: SaidLink }
  | { readonly _tag: "Fact"; readonly fact: Fact; readonly at: number }

/**
 * The most characters of an embedder's model name that keys vectors of what is recalled: a key holds the model, a
 * line feed and the item's text (a fact is at most `FACT_LIMIT` characters, a link's sentence fewer), so the two fit
 * in `KEY_LIMIT` whole and no two items share a key.
 *
 * @public
 */
export const MODEL_LIMIT = KEY_LIMIT - FACT_LIMIT - 1

/**
 * A host's own order for what a search found (`withRecall`'s `reorder`): given the question and the items found,
 * best first by likeness, each with its cosine, it gives a score for each item, in the same order, the higher the
 * better (a cross-encoder, keywords). The kernel holds none: it is the host's function, not a contract.
 *
 * @public
 */
export type Reorder = (
  question: string,
  found: ReadonlyArray<{ readonly item: RecallItem; readonly score: number }>,
) => Effect.Effect<ReadonlyArray<number>, PluginFailure>

/**
 * The options of `withRecall`: at most how many items a request is sent (`limit`, 1 to 50); how many keys a search
 * finds before they are cut to the limit (`pool`, at least `limit` and at most 100; `limit` or 20, whichever is more,
 * unless given); and, when the host gives one, its own order for what was found (`reorder`).
 *
 * @public
 */
export interface RecallOptions {
  readonly limit: number
  readonly pool?: number
  readonly reorder?: Reorder
}

/**
 * An item as `plugin.recall.recalled` lists it: its kind and id, its text, and its score (a cosine in the list
 * found, the host's score in the list reordered).
 *
 * @public
 */
export const RecallEntry = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("link"), id: LinkId, text: Schema.String, score: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("fact"), id: FactId, text: Schema.String, score: Schema.Number }),
])
export type RecallEntry = typeof RecallEntry.Type

/**
 * A list of `plugin.recall.recalled`: at most `RECALL_SHOWN` entries, best first, and how many more there were.
 *
 * @public
 */
export const RecallList = Schema.Struct({ entries: Schema.Array(RecallEntry), more: Schema.Number })
export type RecallList = typeof RecallList.Type

/**
 * The data of `plugin.recall.recalled`: what one request's recall did. The question (at most `QUESTION_SHOWN`
 * characters, what was cut counted); the embedder's model; the options it ran with; the items the search found by
 * meaning, best first, each with its cosine (`found`); when a host's reorder ran, the same items in its order, each
 * with its score (`reordered`, null when none ran); and the ids sent, in the order sent.
 *
 * @public
 */
export const RecalledByMeaningData = Schema.Struct({
  question: Schema.String,
  model: Schema.String,
  limit: Schema.Number,
  pool: Schema.Number,
  found: RecallList,
  reordered: Schema.NullOr(RecallList),
  sent: Schema.Array(Schema.Union([LinkId, FactId])),
})
export type RecalledByMeaningData = typeof RecalledByMeaningData.Type

/**
 * `plugin.recall.recalled`: what `withRecall` found for one request (ADR 0021, amended), said live about the turn and
 * never stored, tagged `trace`. It is said for every model call the memory builds a context for, whether or not
 * anything stands or was found, so a client can show why a request was sent what it was, or nothing.
 *
 * @public
 */
export const recalledByMeaningEvent = liveEvent("recall", "recalled", { tags: ["trace"], data: RecalledByMeaningData })
