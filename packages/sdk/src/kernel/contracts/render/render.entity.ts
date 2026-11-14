import { Schema } from "effect"
import { liveEvent, storedEvent } from "@xandreed/core/kernel"

/**
 * A view's name in its session, chosen by whoever shows it (a tool takes it
 * from the model): a later view with the same id replaces it.
 *
 * @public
 */
export const ViewId = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(80)).pipe(Schema.brand("ViewId"))
export type ViewId = typeof ViewId.Type

/** A cell, an item or a line: plain text, never markup, since a model may have written it. */
const Line = Schema.String.check(Schema.isMaxLength(2000))

/**
 * Text in a block of its own.
 *
 * @public
 */
export const TextView = Schema.TaggedStruct("Text", { text: Line })

/**
 * Items, one after another, under an optional title.
 *
 * @public
 */
export const ListView = Schema.TaggedStruct("List", { title: Schema.optionalKey(Line), items: Schema.Array(Line) })

/**
 * Rows of cells under named columns, each row with as many cells as there are columns.
 *
 * @public
 */
export const TableView = Schema.TaggedStruct("Table", {
  title: Schema.optionalKey(Line),
  columns: Schema.Array(Line).check(Schema.isMinLength(1)),
  rows: Schema.Array(Schema.Array(Line)),
}).check(Schema.makeFilter((table) => table.rows.every((row) => row.length === table.columns.length) ? true : `each row needs ${table.columns.length} cells, one per column`))

/**
 * A title and a body, as a card.
 *
 * @public
 */
export const CardView = Schema.TaggedStruct("Card", { title: Line, body: Line })

/**
 * What a client can show: the whole vocabulary. Closed on purpose: a client
 * draws each shape it knows, and a record of a shape it does not is passed
 * over (`plugin.render.view` may be skipped).
 *
 * @public
 */
export const View = Schema.Union([TextView, ListView, TableView, CardView]).pipe(Schema.toTaggedUnion("_tag"))
export type View = typeof View.Type

/**
 * The data of `plugin.render.view`: a view, under its id.
 *
 * @public
 */
export const ViewData = Schema.Struct({ id: ViewId, view: View })
export type ViewData = typeof ViewData.Type

/**
 * `plugin.render.view`: what the UI shows, stored, tagged `ui`. It bears no
 * message, so no memory sends it: the model never sees a view. A later record
 * with the same id replaces the view; a client folds them (`viewsOf`).
 *
 * @public
 */
export const viewEvent = storedEvent("render", "view", { data: ViewData, skippable: true, tags: ["ui"] })

/**
 * The data of `plugin.render.progress`: how far the work behind a view has got.
 *
 * @public
 */
export const ProgressData = Schema.Struct({
  id: ViewId,
  done: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type ProgressData = typeof ProgressData.Type

/**
 * `plugin.render.progress`: live, tagged `ui`, never stored: progress is
 * for whoever watches now, and the view the work ends with is what stays.
 * A tool publishes it through its turn: `turn.publish(progressEvent, { id,
 * done, total })`.
 *
 * @public
 */
export const progressEvent = liveEvent("render", "progress", { data: ProgressData, tags: ["ui"] })
