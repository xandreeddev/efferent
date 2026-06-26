import { buildConversation, buildConversationRows, searchConversation } from "../presentation/conversation.js"
import {
  buildStackRowsData,
  stackRowText,
  treeRows,
} from "../presentation/sidePane.js"
import { treeRowText } from "../presentation/contextTreeView.js"
import { buildContextRowsData, contextRowText } from "../presentation/contextView.js"
import type { TuiStore } from "../state/store.js"

/**
 * `/` search, routed to the focused pane (`store.searchPane()`). Pure store
 * manipulation (no Effect). The **conversation** matches at ROW granularity
 * (turn heads, body items, checkpoints — `searchConversation`); jumping to a
 * match REVEALS it first — the containing turn unfolds, a containing tool group
 * expands — then the scroller brings it into view and the fold cursor parks on
 * it. The **side** pane matches its current rows' text and stores the matching
 * *row indices* (the stack/context cursors are index-based, so jumping to a
 * match is just moving that cursor — the pane's own scroll-into-view effect
 * follows). n/N cycle; the render tints every conversation match row and the
 * side cursor marks the current one.
 *
 * Matching is a snapshot at search time — re-run `/<query>` after new turns or
 * folds to refresh. A miss keeps an (empty) search so the status line can report
 * it.
 */
const revealAndScroll = (store: TuiStore): void => {
  const s = store.search()
  if (s === undefined) return
  const id = s.matchIds[s.index]
  if (id === undefined) return
  // Reveal: unfold the turn hiding the match (remove from `collapsed`) and/or
  // expand its tool group (ADD to `collapsed` — inverse polarity). Folds opened
  // by visiting matches stay open, like vim's zv.
  const hit = s.hits?.[s.index]
  if (hit !== undefined) {
    const collapsed = new Set(store.collapsed())
    let changed = false
    if (hit.turnId !== undefined && collapsed.has(hit.turnId)) {
      collapsed.delete(hit.turnId)
      changed = true
    }
    if (hit.groupId !== undefined && !collapsed.has(hit.groupId)) {
      collapsed.add(hit.groupId)
      changed = true
    }
    if (changed) store.setCollapsed(collapsed)
  }
  // A row revealed this tick mounts now (Solid is synchronous) but OpenTUI lays
  // it out on a later frame — re-scroll once after layout settles (same pattern
  // as the scroller's own scrollToBottom).
  store.convScroller.current?.scrollIntoView(id)
  setTimeout(() => store.convScroller.current?.scrollIntoView(id), 50)
  // Park the fold cursor on the current match so it gets the cursor highlight
  // (and the tint moves with n/N). Rows are rebuilt AFTER the reveal, so a
  // freshly-unfolded body row is present and findable.
  const rows = buildConversationRows(buildConversation(store.viewBlocks()), store.collapsed())
  const idx = rows.findIndex((r) => r.key === id)
  if (idx !== -1) store.setConvCursor(idx)
}

const runConversationSearch = (store: TuiStore, query: string, q: string): void => {
  const hits = searchConversation(buildConversation(store.viewBlocks()), q)
  if (hits.length === 0) {
    store.setSearch({ query, pane: "conversation", matchIds: [], index: 0, hits: [] })
    return
  }
  // Land on the most recent (bottom-most) match, like the old `/` jump, and move
  // focus to the conversation so n/N work immediately.
  store.setSearch({
    query,
    pane: "conversation",
    matchIds: hits.map((h) => h.id),
    index: hits.length - 1,
    hits,
  })
  store.setFocus("chat")
  store.setMode("normal")
  revealAndScroll(store)
}

/** The focused side view's row texts + a setter for its (index-based) cursor. */
const sideView = (store: TuiStore): { texts: string[]; setCursor: (i: number) => void } => {
  const nav = store.nav()
  if (store.sidePane().view === "tree") {
    const rows = treeRows(nav, store.projection())
    return {
      texts: rows.map(treeRowText),
      setCursor: (i) => store.setNav((n) => ({ ...n, treeCursor: i })),
    }
  }
  if (store.sidePane().view === "stack") {
    const rows = buildStackRowsData(store.projection(), nav.stackCollapsed)
    return {
      texts: rows.map(stackRowText),
      setCursor: (i) => store.setNav((n) => ({ ...n, stackCursor: i })),
    }
  }
  const rows = buildContextRowsData(
    store.projection().context ?? [],
    nav.contextCollapsed,
    nav.contextSelected,
    nav.contextHandoffSelected,
  )
  return {
    texts: rows.map(contextRowText),
    setCursor: (i) => store.setNav((n) => ({ ...n, contextCursor: i })),
  }
}

const runSideSearch = (store: TuiStore, query: string, q: string): void => {
  const { texts, setCursor } = sideView(store)
  const matchIds = texts
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.toLowerCase().includes(q))
    .map(({ i }) => String(i))
  if (matchIds.length === 0) {
    store.setSearch({ query, pane: "side", matchIds: [], index: 0 })
    return
  }
  const index = matchIds.length - 1
  store.setSearch({ query, pane: "side", matchIds, index })
  store.setFocus("tree")
  store.setMode("normal")
  setCursor(Number(matchIds[index]))
}

export const runSearch = (store: TuiStore, query: string): void => {
  const q = query.trim().toLowerCase()
  if (q.length === 0) {
    store.setSearch(undefined)
    return
  }
  if (store.searchPane() === "side") runSideSearch(store, query, q)
  else runConversationSearch(store, query, q)
}

/** n / N — advance to the next / previous match, wrapping at the ends. */
export const cycleSearch = (store: TuiStore, dir: 1 | -1): void => {
  const s = store.search()
  if (s === undefined || s.matchIds.length === 0) return
  const n = s.matchIds.length
  const index = (s.index + dir + n) % n
  store.setSearch({ ...s, index })
  if (s.pane === "side") {
    const id = s.matchIds[index]
    if (id !== undefined) sideView(store).setCursor(Number(id))
  } else {
    revealAndScroll(store)
  }
}

export const clearSearch = (store: TuiStore): void => {
  store.setSearch(undefined)
}
