import {
  sideCursorMove,
  sideCursorToEnd,
  sideCursorToTop,
  sideCurrentRow,
  sideToggleNode,
  sideToggleSelect,
} from "../presentation/sidePane.js"
import { buildConversation, foldableIds } from "../presentation/conversation.js"
import { buildFromSelection } from "../actions/session.js"
import { clearSearch, cycleSearch } from "../actions/search.js"
import type { TuiContext, TuiStore } from "../state/store.js"
import { overlayKey } from "./overlay.js"
import type { Key } from "./ParsedKey.js"

export type { Key } from "./ParsedKey.js"

/** Fold all turns/tool-groups, or unfold them all if any are folded (`Z`). */
const toggleFoldAll = (store: TuiStore): void => {
  const ids = foldableIds(buildConversation(store.blocks()))
  const anyFolded = ids.some((id) => store.collapsed().has(id))
  store.setCollapsed(anyFolded ? new Set() : new Set(ids))
}

/**
 * Conversation-pane navigation (NORMAL, vim deferred). Drives the scroller the
 * pane registered: j/k·↑/↓ scroll a line, Ctrl-D/U a half page, PgUp/PgDn a
 * page, gg/G top/bottom. `Z` folds/unfolds all turns. When a search is active,
 * n/N cycle matches and Esc clears it. Returns true iff it consumed the key.
 */
const conversationKey = (ctx: TuiContext, key: Key): boolean => {
  const { store } = ctx
  const scr = store.convScroller.current

  // `G` → bottom; `g` arms a `gg` two-stroke (→ top).
  if (key.name === "g" && key.shift) {
    store.setGPending(false)
    scr?.scrollToBottom()
    return true
  }
  if (key.name === "g" && !key.ctrl && !key.meta) {
    if (store.gPending()) {
      store.setGPending(false)
      scr?.scrollToTop()
    } else {
      store.setGPending(true)
    }
    return true
  }
  store.setGPending(false)

  // Active search: n next · N prev · Esc clears.
  if (store.search() !== undefined) {
    if (key.name === "n" && !key.ctrl && !key.meta) {
      cycleSearch(store, key.shift ? -1 : 1)
      return true
    }
    if (key.name === "escape") {
      clearSearch(store)
      return true
    }
  }

  const rows = scr?.viewportRows() ?? 20
  const half = Math.max(1, Math.floor(rows / 2))
  const page = Math.max(1, Math.floor(rows * 0.9))

  switch (key.name) {
    case "j":
    case "down":
      scr?.scrollBy(1)
      return true
    case "k":
    case "up":
      scr?.scrollBy(-1)
      return true
    case "d":
      if (!key.ctrl) return false
      scr?.scrollBy(half)
      return true
    case "u":
      if (!key.ctrl) return false
      scr?.scrollBy(-half)
      return true
    case "pagedown":
      scr?.scrollBy(page)
      return true
    case "pageup":
      scr?.scrollBy(-page)
      return true
    case "z":
      // `Z` folds all; plain `z` falls through to the zoom toggle below.
      if (!key.shift) return false
      toggleFoldAll(store)
      return true
    default:
      return false
  }
}

/**
 * Context-viewer navigation when the side pane is focused (NORMAL). Mirrors the
 * `view === "context"` branch of the old `navKeys.ts`, driving the pure
 * `tui/sidePane.ts` reducers: j/k·↑/↓ move the cursor, gg/G jump, Tab/h/l·←/→
 * fold the row, Space selects a turn/handoff, Enter folds a collapsible row, b
 * builds a session from the picks. Returns true iff it consumed the key.
 */
const sideContextKey = (ctx: TuiContext, key: Key): boolean => {
  const { store } = ctx

  // `G` (lowercased name + shift) → bottom; `g` arms a `gg` two-stroke.
  if (key.name === "g" && key.shift) {
    store.setGPending(false)
    store.setNav((n) => sideCursorToEnd(n, store.projection()))
    return true
  }
  if (key.name === "g" && !key.ctrl && !key.meta) {
    if (store.gPending()) {
      store.setGPending(false)
      store.setNav(sideCursorToTop)
    } else {
      store.setGPending(true)
    }
    return true
  }
  store.setGPending(false)

  switch (key.name) {
    case "j":
    case "down":
      store.setNav((n) => sideCursorMove(n, store.projection(), 1))
      return true
    case "k":
    case "up":
      store.setNav((n) => sideCursorMove(n, store.projection(), -1))
      return true
    case "tab":
    case "h":
    case "l":
    case "left":
    case "right":
      store.setNav((n) => sideToggleNode(n, store.projection()))
      return true
    case "return": {
      // Enter folds a collapsible row; jumping the conversation cursor to a
      // message row arrives with the conversation-pane vim cursor in Phase E.
      const row = sideCurrentRow(store.nav(), store.projection())
      if (row?.collapsible === true) store.setNav((n) => sideToggleNode(n, store.projection()))
      return true
    }
    case "space":
      store.setNav((n) => sideToggleSelect(n, store.projection()))
      return true
    case "b":
      void ctx.run(buildFromSelection(store, store.status().cwd))
      return true
    case "i":
      store.setFocus("input")
      store.setMode("insert")
      return true
    default:
      return false
  }
}

/**
 * Root key dispatch — the global precedence the focused `<textarea>` doesn't
 * consume. Order: overlay → quit → interrupt → pane focus → side/conversation
 * nav → zoom. Vim modal editing is deferred; the read-only panes route only
 * scroll / fold / search / context-viewer keys.
 */
export const dispatch = (ctx: TuiContext, key: Key): void => {
  const { store } = ctx

  // A modal overlay owns all input while open (Esc/Ctrl-C close it there).
  if (overlayKey(ctx, key)) return

  // Ctrl-C → 2×-to-quit: first press arms (with a hint), a second within 2 s exits.
  if (key.ctrl && key.name === "c") {
    const now = Date.now()
    const armed = store.run.getCtrlCArmedAt()
    if (armed !== undefined && now - armed < 2000) {
      ctx.exit()
    } else {
      store.run.setCtrlCArmedAt(now)
      store.pushBlock({ kind: "info", text: "press Ctrl-C again to quit" })
    }
    return
  }

  // Esc → interrupt a running turn.
  if (key.name === "escape" && store.busy()) {
    ctx.interrupt()
    return
  }

  // Pane focus: conversation (h/k) · side (l) · input (j). Read-only panes get
  // NORMAL, the input gets INSERT.
  if (key.ctrl && (key.name === "h" || key.name === "k" || key.name === "up")) {
    store.setFocus("conversation")
    store.setMode("normal")
    return
  }
  if (key.ctrl && (key.name === "l" || key.name === "right")) {
    store.setFocus("side")
    store.setMode("normal")
    return
  }
  if (key.ctrl && (key.name === "j" || key.name === "down")) {
    store.setFocus("input")
    store.setMode("insert")
    return
  }

  // Side pane, context viewer: cursor / fold / select / build.
  if (
    !key.ctrl &&
    !key.meta &&
    store.focus() === "side" &&
    store.sidePane().view === "context" &&
    sideContextKey(ctx, key)
  ) {
    return
  }

  // Conversation pane: scroll / fold-all / search nav (Ctrl-D/U allowed here).
  if (!key.meta && store.focus() === "conversation" && conversationKey(ctx, key)) {
    return
  }

  // `y` yanks the current OpenTUI mouse selection to the clipboard (read-only
  // panes only; the input's textarea owns its own selection/copy).
  if (key.name === "y" && !key.ctrl && !key.meta && store.focus() !== "input") {
    ctx.copySelection()
    return
  }

  // `z` zooms the focused read-only pane (never while typing in the input).
  if (key.name === "z" && !key.ctrl && !key.meta && store.focus() !== "input") {
    store.setZoomed(!store.zoomed())
    return
  }
}
