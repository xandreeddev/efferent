import {
  sideCursorMove,
  sideCursorToEnd,
  sideCursorToHead,
  sideCursorToTop,
  sideCurrentRow,
  sideToggleNode,
  sideToggleSelect,
  stackCurrentRow,
  stackFold,
  stackMessage,
  stackParagraph,
  stackToEnd,
  stackToTop,
  treeCurrentRow,
  treeFold,
  treeMessage,
  treeParagraph,
  treeToEnd,
  treeToTop,
} from "../presentation/sidePane.js"
import { buildConversation, buildConversationRows, foldIdsByKind } from "../presentation/conversation.js"
import { clampCursor, enclosingFoldId, rowIndexOfKey, rowToEnd, rowToTop, stepHead, stepRow } from "../presentation/paneNav.js"
import { computePalette, PALETTE_VISIBLE } from "../presentation/slashPalette.js"
import { historyNext, historyPrev } from "../presentation/promptHistory.js"
import { buildFromSelection } from "../actions/session.js"
import { clearSearch, cycleSearch, runSearch } from "../actions/search.js"
import { runCommand } from "../commands/runCommand.js"
import type { TuiContext, TuiStore } from "../state/store.js"
import { bracketMotion } from "./brackets.js"
import { overlayKey } from "./overlay.js"
import type { Key } from "./ParsedKey.js"

export type { Key } from "./ParsedKey.js"

/**
 * `Z` toggles between fully-compact and fully-expanded. Turns and tool groups
 * default oppositely (turn expanded, group collapsed-to-summary), so "compact" =
 * every turn folded (∈ set) AND every group collapsed (∉ set). From compact we
 * expand both (groups ∈ set, turns ∉); otherwise we make it compact.
 */
const toggleFoldAll = (store: TuiStore): void => {
  const { turns, groups } = foldIdsByKind(buildConversation(store.blocks()))
  const collapsed = store.collapsed()
  const compact =
    turns.every((id) => collapsed.has(id)) && groups.every((id) => !collapsed.has(id))
  store.setCollapsed(compact ? new Set(groups) : new Set(turns))
}

/** n next · N prev · Esc clear — when a search is active (any focused pane). */
const searchNavKey = (store: TuiStore, key: Key): boolean => {
  if (store.search() === undefined) return false
  if (key.name === "n" && !key.ctrl && !key.meta) {
    cycleSearch(store, key.shift ? -1 : 1)
    return true
  }
  if (key.name === "escape") {
    clearSearch(store)
    return true
  }
  return false
}

/** The conversation's navigable rows + the clamped fold-cursor index. */
const convNav = (store: TuiStore) => {
  const rows = buildConversationRows(buildConversation(store.blocks()), store.collapsed())
  return { rows, cursor: clampCursor(rows.length, store.convCursor()) }
}

/**
 * Move the conversation fold cursor to `next` and scroll that row into view —
 * **imperatively**, only on a motion keypress. (Scrolling reactively on the
 * cursor signal would also fire as content streams, fighting the scrollbox's
 * sticky-bottom and stranding fresh output below the fold.)
 */
const moveConvCursor = (store: TuiStore, next: number): void => {
  const { rows } = convNav(store)
  const i = clampCursor(rows.length, next)
  store.setConvCursor(i)
  const key = rows[i]?.key
  if (key !== undefined) store.convScroller.current?.scrollIntoView(key)
}

/**
 * Conversation-pane navigation (NORMAL). Two decoupled things, vim-style:
 * `j/k`·↑/↓ scroll a line, Ctrl-D/U a half page, PgUp/PgDn a page (the viewport);
 * `{`/`}` step the fold cursor by paragraph, `[`/`]` by message, gg/G to the
 * first/last unit (the cursor — the view scrolls it into view). Tab/Enter/h/l·←→
 * fold the unit under the cursor; `Z` folds/unfolds all. While a search is
 * active, n/N cycle matches and Esc clears it. Returns true iff it consumed the
 * key.
 */
const conversationKey = (ctx: TuiContext, key: Key): boolean => {
  const { store } = ctx
  const scr = store.convScroller.current

  // `G` → last unit + the ABSOLUTE bottom; `g` arms a `gg` two-stroke (→ first
  // unit + the ABSOLUTE top). gg/G scroll to the edge, not `scrollIntoView` — a
  // huge first/last message is taller than the viewport, so a minimal "into view"
  // scroll stops at its near edge and never reaches the very top/bottom.
  if (key.name === "g" && key.shift) {
    store.setGPending(false)
    store.setConvCursor(rowToEnd(convNav(store).rows))
    scr?.scrollToBottom()
    return true
  }
  if (key.name === "g" && !key.ctrl && !key.meta) {
    if (store.gPending()) {
      store.setGPending(false)
      store.setConvCursor(rowToTop())
      scr?.scrollToTop()
    } else {
      store.setGPending(true)
    }
    return true
  }
  store.setGPending(false)

  // Active search: n next · N prev · Esc clears.
  if (searchNavKey(store, key)) return true

  // `{`/`}` paragraph step · `[`/`]` message step (move the fold cursor).
  const bracket = bracketMotion(key)
  if (bracket !== undefined) {
    const { rows, cursor } = convNav(store)
    moveConvCursor(
      store,
      bracket === "paragraph-prev"
        ? stepRow(rows, cursor, -1)
        : bracket === "paragraph-next"
          ? stepRow(rows, cursor, 1)
          : stepHead(rows, cursor, bracket === "message-next" ? 1 : -1),
    )
    return true
  }

  const vrows = scr?.viewportRows() ?? 20
  const half = Math.max(1, Math.floor(vrows / 2))
  const page = Math.max(1, Math.floor(vrows * 0.9))

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
    case "tab":
    case "h":
    case "l":
    case "left":
    case "right":
    case "return": {
      // Fold the ENCLOSING turn / tool-group of the cursor row (works from a body
      // line too), then park the cursor on that head so it isn't stranded on a row
      // the fold just hid, and the tint follows.
      const { rows, cursor } = convNav(store)
      const id = enclosingFoldId(rows, cursor)
      if (id !== undefined) {
        const collapsed = store.collapsed()
        const next = new Set(collapsed)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        store.setCollapsed(next)
        store.setConvCursor(rowIndexOfKey(convNav(store).rows, id, cursor))
      }
      return true
    }
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

  // Active search: n next · N prev · Esc clears.
  if (searchNavKey(store, key)) return true

  // `{`/`}` paragraph step (one row) · `[`/`]` message step (segment/turn head).
  const bracket = bracketMotion(key)
  if (bracket === "paragraph-prev") {
    store.setNav((n) => sideCursorMove(n, store.projection(), -1))
    return true
  }
  if (bracket === "paragraph-next") {
    store.setNav((n) => sideCursorMove(n, store.projection(), 1))
    return true
  }
  if (bracket === "message-prev") {
    store.setNav((n) => sideCursorToHead(n, store.projection(), -1))
    return true
  }
  if (bracket === "message-next") {
    store.setNav((n) => sideCursorToHead(n, store.projection(), 1))
    return true
  }

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
 * Activity (stack) view navigation when the side pane is focused (NORMAL). The
 * same motion vocabulary as the context viewer minus select/build: j/k·`{}` step
 * one row, `[]` jumps the prev/next tree-root or section head, gg/G jump to the
 * ends, Tab/Enter/h/l·←/→ fold the container/section under the cursor, i drops to
 * the input. Returns true iff it consumed the key.
 */
const sideStackKey = (ctx: TuiContext, key: Key): boolean => {
  const { store } = ctx

  if (key.name === "g" && key.shift) {
    store.setGPending(false)
    store.setNav((n) => stackToEnd(n, store.projection()))
    return true
  }
  if (key.name === "g" && !key.ctrl && !key.meta) {
    if (store.gPending()) {
      store.setGPending(false)
      store.setNav(stackToTop)
    } else {
      store.setGPending(true)
    }
    return true
  }
  store.setGPending(false)

  // Active search: n next · N prev · Esc clears.
  if (searchNavKey(store, key)) return true

  const bracket = bracketMotion(key)
  if (bracket === "paragraph-prev") {
    store.setNav((n) => stackParagraph(n, store.projection(), -1))
    return true
  }
  if (bracket === "paragraph-next") {
    store.setNav((n) => stackParagraph(n, store.projection(), 1))
    return true
  }
  if (bracket === "message-prev") {
    store.setNav((n) => stackMessage(n, store.projection(), -1))
    return true
  }
  if (bracket === "message-next") {
    store.setNav((n) => stackMessage(n, store.projection(), 1))
    return true
  }

  switch (key.name) {
    case "j":
    case "down":
      store.setNav((n) => stackParagraph(n, store.projection(), 1))
      return true
    case "k":
    case "up":
      store.setNav((n) => stackParagraph(n, store.projection(), -1))
      return true
    case "tab":
    case "h":
    case "l":
    case "left":
    case "right":
      store.setNav((n) => stackFold(n, store.projection()))
      return true
    case "return": {
      const row = stackCurrentRow(store.nav(), store.projection())
      if (row?.foldId !== undefined) store.setNav((n) => stackFold(n, store.projection()))
      return true
    }
    case "i":
      store.setFocus("input")
      store.setMode("insert")
      return true
    default:
      return false
  }
}

/**
 * Context-tree (`:tree`) navigation when the side pane is focused (NORMAL). A
 * read-only browse of the persistent branching agent-context tree: j/k·`{}` step
 * one node, `[]` jumps forest roots, gg/G jump to the ends, Tab/Enter/h/l·←/→
 * fold the node under the cursor, i drops to the input. Returns true iff it
 * consumed the key.
 */
const sideTreeKey = (ctx: TuiContext, key: Key): boolean => {
  const { store } = ctx

  if (key.name === "g" && key.shift) {
    store.setGPending(false)
    store.setNav((n) => treeToEnd(n, store.projection()))
    return true
  }
  if (key.name === "g" && !key.ctrl && !key.meta) {
    if (store.gPending()) {
      store.setGPending(false)
      store.setNav(treeToTop)
    } else {
      store.setGPending(true)
    }
    return true
  }
  store.setGPending(false)

  if (searchNavKey(store, key)) return true

  const bracket = bracketMotion(key)
  if (bracket === "paragraph-prev") {
    store.setNav((n) => treeParagraph(n, store.projection(), -1))
    return true
  }
  if (bracket === "paragraph-next") {
    store.setNav((n) => treeParagraph(n, store.projection(), 1))
    return true
  }
  if (bracket === "message-prev") {
    store.setNav((n) => treeMessage(n, store.projection(), -1))
    return true
  }
  if (bracket === "message-next") {
    store.setNav((n) => treeMessage(n, store.projection(), 1))
    return true
  }

  switch (key.name) {
    case "j":
    case "down":
      store.setNav((n) => treeParagraph(n, store.projection(), 1))
      return true
    case "k":
    case "up":
      store.setNav((n) => treeParagraph(n, store.projection(), -1))
      return true
    case "tab":
    case "h":
    case "l":
    case "left":
    case "right":
      store.setNav((n) => treeFold(n, store.projection()))
      return true
    case "return": {
      const row = treeCurrentRow(store.nav(), store.projection())
      if (row?.foldId !== undefined) store.setNav((n) => treeFold(n, store.projection()))
      return true
    }
    case "i":
      store.setFocus("input")
      store.setMode("insert")
      return true
    default:
      return false
  }
}

/**
 * Input-pane (INSERT) keys claimed BEFORE the focused `<textarea>`. OpenTUI fires
 * global key listeners (this dispatch) before the focused renderable and skips it
 * when the event is `preventDefault()`-ed, so `dispatch` can take a key the
 * textarea would otherwise handle (see `Key.preventDefault`):
 *
 *  - command palette open (buffer is a bare `:token`): `↑`/`↓` move the highlight,
 *    `⇥`/`→` complete the buffer to it, `↵` runs it (no Shift-Enter needed);
 *  - any `:command` / `/search` line: `↵` runs it;
 *  - a single-line ordinary message: `↑`/`↓` recall sent-message history.
 *
 * Anything else (typing, multi-line `↵`→newline, cursor motion) falls through to
 * the textarea. Returns true (after `preventDefault`) iff it consumed the key.
 */
const inputKey = (ctx: TuiContext, key: Key): boolean => {
  const { store } = ctx
  if (key.ctrl || key.meta || key.option) return false
  const text = store.input()
  const claim = (): true => {
    key.preventDefault?.()
    return true
  }

  const isCommand = text.startsWith(":")
  const isSearch = text.startsWith("/") && text.length > 1
  const paletteOpen = isCommand && !text.includes(" ") && !text.includes("\n")
  // The navigable/visible slice (keymap + view agree via PALETTE_VISIBLE).
  const matches = paletteOpen ? computePalette(text).matches.slice(0, PALETTE_VISIBLE) : []
  const palIdx = clampCursor(matches.length, store.paletteIndex())

  if (paletteOpen && !key.shift && matches.length > 0) {
    if (key.name === "up") {
      store.setPaletteIndex((palIdx - 1 + matches.length) % matches.length)
      return claim()
    }
    if (key.name === "down") {
      store.setPaletteIndex((palIdx + 1) % matches.length)
      return claim()
    }
    if (key.name === "tab" || key.name === "right") {
      // Complete to the highlighted command + a trailing space (ready for args).
      store.inputControl.current?.seed(`${matches[palIdx]!.name} `)
      store.setPaletteIndex(0)
      return claim()
    }
  }

  // Enter (no Shift) runs a command / search line outright.
  if (key.name === "return" && !key.shift && (isCommand || isSearch)) {
    store.inputControl.current?.seed("")
    store.setPaletteIndex(0)
    if (isCommand) {
      // A bare `:token` runs the *highlighted* command; an args line runs as typed.
      runCommand(ctx, paletteOpen && matches[palIdx] !== undefined ? matches[palIdx]!.name : text)
    } else {
      runSearch(store, text.slice(1))
    }
    return claim()
  }

  // Single-line ordinary buffer: ↑/↓ recall sent-message history.
  if (!key.shift && !isCommand && !isSearch && !text.includes("\n")) {
    if (key.name === "up") {
      const r = historyPrev(store.history(), text)
      if (r !== undefined) {
        store.setHistory(r.history)
        store.inputControl.current?.seed(r.text)
      }
      return claim()
    }
    if (key.name === "down") {
      const r = historyNext(store.history())
      if (r !== undefined) {
        store.setHistory(r.history)
        store.inputControl.current?.seed(r.text)
      }
      return claim()
    }
  }
  return false
}

/**
 * Root key dispatch — the global precedence the focused `<textarea>` doesn't
 * consume. Order: overlay → quit → interrupt → pane focus → input keys →
 * side/conversation nav → zoom. Vim modal editing is deferred; the read-only
 * panes route only scroll / fold / search / context-viewer keys.
 */
export const dispatch = (ctx: TuiContext, key: Key): void => {
  const { store } = ctx

  // A modal overlay owns all input while open (Esc/Ctrl-C close it there).
  if (overlayKey(ctx, key)) return

  // Ctrl-Shift-C → copy the current mouse selection (the conventional terminal
  // copy gesture, any focus). Same path as `y`, but global. MUST precede the
  // Ctrl-C quit handler — otherwise Shift+Ctrl+C arms the quit instead of copying.
  // (Only fires if the terminal forwards it to the app, which OpenTUI's Kitty-
  // protocol request enables; terminals that intercept it copy their own — empty
  // in mouse mode — selection, which can't be fixed in code.)
  if (key.ctrl && key.shift && key.name === "c") {
    ctx.copySelection()
    return
  }

  // Ctrl-C → 2×-to-quit: first press arms (with a hint), a second within 2 s exits.
  if (key.ctrl && !key.shift && key.name === "c") {
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
    // Land the fold cursor on the newest unit (bottom, where sticky-scroll sits)
    // so re-entering the pane shows the cursor on-screen, not off at the top.
    store.setConvCursor(rowToEnd(convNav(store).rows))
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

  // `/` in a read-only pane opens a search FOR that pane: remember which pane,
  // drop to the input, and seed the buffer with "/" so the user just types the
  // query (submit routes via `searchPane`).
  if (key.name === "/" && !key.ctrl && !key.meta && store.focus() !== "input") {
    store.setSearchPane(store.focus() === "side" ? "side" : "conversation")
    store.setFocus("input")
    store.setMode("insert")
    store.inputControl.current?.seed("/")
    return
  }

  // Input pane (INSERT): palette nav/complete/run + prompt-history recall, claimed
  // before the textarea (via preventDefault) so the right keys reach the command
  // line instead of inserting a newline / moving the cursor.
  if (store.focus() === "input" && store.overlay().kind === "none" && inputKey(ctx, key)) {
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

  // Side pane, Activity view: cursor / fold over the live execution dashboard.
  if (
    !key.ctrl &&
    !key.meta &&
    store.focus() === "side" &&
    store.sidePane().view === "stack" &&
    sideStackKey(ctx, key)
  ) {
    return
  }

  // Side pane, context-tree view: cursor / fold over the persistent agent tree.
  if (
    !key.ctrl &&
    !key.meta &&
    store.focus() === "side" &&
    store.sidePane().view === "tree" &&
    sideTreeKey(ctx, key)
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
