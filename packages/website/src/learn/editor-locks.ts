// The code editor shows a whole program but lets the learner change only part
// of it. The editable region is tracked through every edit, and any change that
// touches text outside it is refused. No DOM here: it is plain CodeMirror state,
// so it is tested without a browser.
import { EditorState, StateField } from "@codemirror/state"
import type { Extension } from "@codemirror/state"

export interface Region {
  readonly from: number
  readonly to: number
}

/** The editable region, mapped through each change so it follows the text. */
export const regionField = StateField.define<Region>({
  create: () => ({ from: 0, to: 0 }),
  update: (region, transaction) => ({
    from: transaction.changes.mapPos(region.from, -1),
    to: transaction.changes.mapPos(region.to, 1),
  }),
})

/** Refuse a change that is not wholly inside the editable region (its ends count as inside). */
const guard = EditorState.changeFilter.of((transaction) => {
  const region = transaction.startState.field(regionField)
  let inside = true
  transaction.changes.iterChangedRanges((fromA, toA) => {
    if (fromA < region.from || toA > region.to) inside = false
  })
  return inside
})

/** The extension, with the region's initial bounds. */
export const lockedExtension = (initial: Region): Extension => [
  regionField.init(() => initial),
  guard,
]

/** The text the learner may edit. */
export const editableText = (state: EditorState): string => {
  const { from, to } = state.field(regionField)
  return state.doc.sliceString(from, to)
}
