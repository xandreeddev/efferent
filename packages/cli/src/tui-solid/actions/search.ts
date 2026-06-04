import { buildConversation, conversationItemId, itemText } from "../model/conversation.js"
import type { TuiStore } from "../state/store.js"

/**
 * Conversation `/` search — the non-ANSI analogue of `scrollback.ts`'s search.
 * Pure store manipulation (no Effect): a query is matched against the searchable
 * text of each top-level item, the matching ids are recorded, and the scroller
 * (registered by the conversation pane) brings the current match into view. n/N
 * cycle through `matchIds`; the conversation render highlights them.
 *
 * Matching is a snapshot at search time — re-run `/<query>` after new turns to
 * refresh. A miss keeps an (empty) search so the status line can report it.
 */
const scrollToCurrent = (store: TuiStore): void => {
  const s = store.search()
  if (s === undefined) return
  const id = s.matchIds[s.index]
  if (id !== undefined) store.convScroller.current?.scrollIntoView(id)
}

export const runSearch = (store: TuiStore, query: string): void => {
  const q = query.trim().toLowerCase()
  if (q.length === 0) {
    store.setSearch(undefined)
    return
  }
  const items = buildConversation(store.blocks())
  const matchIds = items
    .map((it, i) => ({ it, id: conversationItemId(it, i) }))
    .filter(({ it }) => itemText(it).toLowerCase().includes(q))
    .map(({ id }) => id)
  if (matchIds.length === 0) {
    store.setSearch({ query, matchIds: [], index: 0 })
    return
  }
  // Land on the most recent (bottom-most) match, like the old `/` jump, and move
  // focus to the conversation so n/N work immediately.
  store.setSearch({ query, matchIds, index: matchIds.length - 1 })
  store.setFocus("conversation")
  store.setMode("normal")
  scrollToCurrent(store)
}

/** n / N — advance to the next / previous match, wrapping at the ends. */
export const cycleSearch = (store: TuiStore, dir: 1 | -1): void => {
  const s = store.search()
  if (s === undefined || s.matchIds.length === 0) return
  const n = s.matchIds.length
  store.setSearch({ ...s, index: (s.index + dir + n) % n })
  scrollToCurrent(store)
}

export const clearSearch = (store: TuiStore): void => {
  store.setSearch(undefined)
}
