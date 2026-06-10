import { buildConversation, buildConversationRows, conversationItemId, itemText } from "../presentation/conversation.js"
import {
  buildStackRowsData,
  sessionsRows,
  stackRowText,
  treeRows,
} from "../presentation/sidePane.js"
import { treeRowText } from "../presentation/contextTreeView.js"
import { buildContextRowsData, contextRowText } from "../presentation/contextView.js"
import type { TuiStore } from "../state/store.js"

/**
 * `/` search, routed to the focused pane (`store.searchPane()`). Pure store
 * manipulation (no Effect). The **conversation** matches top-level item ids and
 * the scroller brings the current match into view; the **side** pane matches its
 * current rows' text and stores the matching *row indices* (the stack/context
 * cursors are index-based, so jumping to a match is just moving that cursor —
 * the pane's own scroll-into-view effect follows). n/N cycle; the render
 * highlights the conversation matches and the side cursor marks the current one.
 *
 * Matching is a snapshot at search time — re-run `/<query>` after new turns or
 * folds to refresh. A miss keeps an (empty) search so the status line can report
 * it.
 */
const scrollToCurrent = (store: TuiStore): void => {
  const s = store.search()
  if (s === undefined) return
  const id = s.matchIds[s.index]
  if (id === undefined) return
  store.convScroller.current?.scrollIntoView(id)
  // Park the fold cursor on the current match so it gets the row highlight (and
  // the tint moves with n/N). A top-level item id is also a nav-row key for turns
  // / checkpoints; a `loose:` run has no own row, so the cursor just stays put.
  const rows = buildConversationRows(buildConversation(store.viewBlocks()), store.collapsed())
  const idx = rows.findIndex((r) => r.key === id)
  if (idx !== -1) store.setConvCursor(idx)
}

const runConversationSearch = (store: TuiStore, query: string, q: string): void => {
  const items = buildConversation(store.viewBlocks())
  const matchIds = items
    .map((it, i) => ({ it, id: conversationItemId(it, i) }))
    .filter(({ it }) => itemText(it).toLowerCase().includes(q))
    .map(({ id }) => id)
  if (matchIds.length === 0) {
    store.setSearch({ query, pane: "conversation", matchIds: [], index: 0 })
    return
  }
  // Land on the most recent (bottom-most) match, like the old `/` jump, and move
  // focus to the conversation so n/N work immediately.
  store.setSearch({ query, pane: "conversation", matchIds, index: matchIds.length - 1 })
  store.setFocus("conversation")
  store.setMode("normal")
  scrollToCurrent(store)
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
  if (store.sidePane().view === "sessions") {
    return {
      texts: sessionsRows(store.projection()).map((r) => r.label),
      setCursor: (i) => store.setNav((n) => ({ ...n, sessionsCursor: i })),
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
  store.setFocus("side")
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
    scrollToCurrent(store)
  }
}

export const clearSearch = (store: TuiStore): void => {
  store.setSearch(undefined)
}
