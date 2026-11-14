import { Option } from "effect"
import { dataOf, stored } from "@xandreed/core/kernel"
import type { Seq, StoredDraft, StoredEvent, TurnNumber } from "@xandreed/core/kernel"
import { viewEvent } from "./render.entity.js"
import type { View, ViewId } from "./render.entity.js"

/**
 * `plugin.render.view`, to append: show `view` under `id`, replacing what
 * was shown under it.
 *
 * @public
 */
export const showView = (id: ViewId, view: View): StoredDraft => stored(viewEvent, { id, view })

/**
 * A view as a client shows it: its latest record, and where its id first
 * appeared, so the client can place it among the messages.
 *
 * @public
 */
export interface Shown {
  readonly id: ViewId
  readonly view: View
  /** The record that first showed this id. */
  readonly firstSeq: Seq
  /** The turn that first showed it. */
  readonly turn: TurnNumber
  /** The record whose view is shown: the latest under this id. */
  readonly seq: Seq
}

/**
 * The views a journal holds, as a client shows them: one per id, the latest
 * record's view, in the order their ids first appeared. Pure: drawing it
 * live and redrawing it from the store are the same fold. A record whose
 * data does not decode (a shape this vocabulary does not know) is passed
 * over.
 *
 * @public
 */
export const viewsOf = (journal: ReadonlyArray<StoredEvent>): ReadonlyArray<Shown> => {
  const shown = new Map<ViewId, Shown>()
  for (const event of journal) {
    Option.map(dataOf(viewEvent, event), ({ id, view }) => {
      const first = shown.get(id)
      shown.set(id, first === undefined ? { id, view, firstSeq: event.seq, turn: event.turn, seq: event.seq } : { ...first, view, seq: event.seq })
    })
  }
  return [...shown.values()]
}
