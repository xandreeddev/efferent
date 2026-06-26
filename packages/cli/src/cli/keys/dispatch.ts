import {
  treeCurrentRow,
  treeFold,
  treeMessage,
  treeParagraph,
  treeToEnd,
  treeToTop,
} from "../presentation/sidePane.js"
import { buildConversation, buildConversationRows, foldIdsByKind } from "../presentation/conversation.js"
import { clampCursor, enclosingFoldId, rowIndexOfKey, rowToEnd, rowToTop, stepHead, stepRow } from "../presentation/paneNav.js"
import { computePalette } from "../presentation/slashPalette.js"
import { historyNext, historyPrev } from "../presentation/promptHistory.js"
import {
  closeNodePreview,
  continueFromNode,
  dropNode,
  openNodePreview,
} from "../actions/contextTree.js"
import { clearSearch, cycleSearch, runSearch } from "../actions/search.js"
import { editLastQueued } from "../actions/submit.js"
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
  const { turns, groups } = foldIdsByKind(buildConversation(store.viewBlocks()))
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
  const rows = buildConversationRows(buildConversation(store.viewBlocks()), store.collapsed())
  return { rows, cursor: clampCursor(rows.length, store.convCursor()) }
}

/**
 * Focus the LEFT chat pane (NORMAL) and land the fold cursor on the newest unit
 * (bottom, where sticky-scroll sits) so re-entering shows the cursor on-screen.
 */
const focusChat = (store: TuiStore): void => {
  store.setFocus("chat")
  store.setMode("normal")
  store.setConvCursor(rowToEnd(convNav(store).rows))
}

/** Focus the RIGHT fleet-tree pane (NORMAL). */
const focusTree = (store: TuiStore): void => {
  store.setFocus("tree")
  store.setMode("normal")
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
 * first/last unit (the cursor — the view scrolls it into view). Enter/h/l·←→
 * fold the unit under the cursor (Tab is the global focus cycle); `Z` folds/
 * unfolds all. While a search is
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
    // Tab is the universal focus cycle (claimed globally before this handler),
    // so the chat folds with `h`/`l`/←/→/↵ — not Tab.
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
      // `Z` folds all; plain `z` is unbound (single region — nothing to zoom).
      if (!key.shift) return false
      toggleFoldAll(store)
      return true
    case "i":
      // To the composer — the strip promises `i type` here (and it's how you
      // talk to the agent whose session preview you're reading). The side
      // panes already had this; the conversation pane silently didn't, so a
      // preview-then-type flow swallowed every keystroke as navigation.
      store.setFocus("input")
      store.setMode("insert")
      return true
    default:
      return false
  }
}

/**
 * Fleet-tree navigation when the tree pane is focused (NORMAL). The single
 * tree handler of the chat-first layout — a browse of the workspace's sessions
 * and their persistent agent subtrees: j/k·`{}` step one node, `[]` jumps
 * forest roots, gg/G jump to the ends, h/l·←/→ fold the node under the cursor
 * (Tab is the global focus cycle), `↵` jumps the LEFT chat into a node's session
 * (open its preview) or,
 * on the active row, returns the chat to the assistant, `c` forks a node into a
 * new session, `d` drops a node, `i` drops to the input. Returns true iff it
 * consumed the key.
 */
const treeKey = (ctx: TuiContext, key: Key): boolean => {
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
    // Tab is the universal focus cycle (claimed globally), so a tree node folds
    // with `h`/`l`/←/→ — not Tab.
    case "h":
    case "l":
    case "left":
    case "right":
      store.setNav((n) => treeFold(n, store.projection()))
      return true
    case "return": {
      // Enter on an AGENT node re-points the LEFT chat to that node's session
      // (open its preview; Enter again on the same node returns to the
      // assistant). Enter on a CONVERSATION (root / active) row returns the
      // chat to the assistant: close any open preview so the live rail shows
      // and the composer feeds the root again. Folding stays on Tab/h/l/←/→.
      const row = treeCurrentRow(store.nav(), store.projection())
      if (row === undefined) return true
      if (row.display.kind === "conversation") {
        if (store.nodePreview() !== undefined) closeNodePreview(store)
        // Route through focusChat so the fold cursor lands on a valid row
        // (the newest unit). A bare setFocus left convCursor at a stale/out-of-
        // bounds index → no row highlighted, nav/expand confusingly inert.
        else focusChat(store)
        return true
      }
      if (store.nodePreview()?.nodeId === row.display.nodeId) {
        closeNodePreview(store)
      } else {
        void ctx.run(openNodePreview(store, row.display.nodeId))
      }
      return true
    }
    case "c": {
      // Continue from an agent node: fork its context into a new conversation
      // and make that the active session (the human takes over from there).
      const row = treeCurrentRow(store.nav(), store.projection())
      if (row !== undefined && row.display.kind === "node") {
        void ctx.run(continueFromNode(store, store.status().cwd, row.display.nodeId))
      }
      return true
    }
    case "d": {
      // Drop the node (+ descendants) under the cursor — but never a still-running
      // one (its in-flight run would fail to record its return), and never a
      // conversation row (deleting whole sessions is not a one-key action).
      const row = treeCurrentRow(store.nav(), store.projection())
      if (
        row !== undefined &&
        row.display.kind === "node" &&
        row.display.status !== "running"
      ) {
        void ctx.run(dropNode(store, store.run.getConversationId(), row.display.nodeId))
      }
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
 *    `⇥`/`→` complete the buffer to it, `↵` runs it;
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

  // NOTE: `?` is NOT special in INSERT — it must always type, or any message
  // with a question mark ("hi?", "what's up?") silently fails to send. (The old
  // "`?` on an empty composer opens shortcuts" affordance keyed off the input
  // MIRROR, which lags the textarea: a `?` typed before the mirror caught up
  // read as empty and popped the shortcuts overlay instead of inserting — the
  // "I type and nothing sends / I don't see my message" bug.) Shortcuts open
  // from NORMAL mode (`?`, see below) and via `:shortcuts`/`:keys`.

  const isCommand = text.startsWith(":")
  const isSearch = text.startsWith("/") && text.length > 1
  const paletteOpen = isCommand && !text.includes(" ") && !text.includes("\n")
  // Navigate the FULL match list — the view (`BottomMenu`) windows it, so ↑/↓
  // reach every command, not just the first screenful.
  const matches = paletteOpen ? computePalette(text).matches : []
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
    // A bare ":" is vim's no-op, not "run whatever happens to be highlighted"
    // — the first palette entry is :exit, so without this guard a stray
    // Enter right after `:` quits the whole app.
    if (text === ":") {
      store.inputControl.current?.seed("")
      store.setPaletteIndex(0)
      return claim()
    }
    store.inputControl.current?.seed("")
    store.setPaletteIndex(0)
    if (isCommand) {
      // A typed `:token` runs the *highlighted* command; an args line runs as typed.
      runCommand(ctx, paletteOpen && matches[palIdx] !== undefined ? matches[palIdx]!.name : text)
    } else {
      runSearch(store, text.slice(1))
    }
    return claim()
  }

  // Single-line ordinary buffer: ↑/↓ recall sent-message history.
  if (!key.shift && !isCommand && !isSearch && !text.includes("\n")) {
    // With messages queued (typed while a turn ran), ↑ on an EMPTY composer
    // pulls the most-recent one back to edit (agy "Press up to edit queued") —
    // it takes precedence over history recall, which an empty buffer would
    // otherwise trigger.
    if (key.name === "up" && text.length === 0 && store.queued().length > 0) {
      editLastQueued(store)
      return claim()
    }
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
 * panel/conversation nav → yank. Vim modal editing is deferred; the read-only
 * panes route only scroll / fold / search / context-viewer keys.
 */
export const dispatch = (ctx: TuiContext, raw: Key): void => {
  // Terminal-input normalization, learned the hard way:
  //  - two Escapes in one input chunk parse as ONE meta+escape (Alt-Esc) —
  //    treat it as Escape, or a fast double-Esc silently swallows the second;
  //  - legacy (non-Kitty) terminals — tmux above all — send Ctrl-J as a bare
  //    linefeed (0x0a). Ctrl-H is unrecoverable there (0x08 IS backspace), so
  //    the hints lead with Esc/w, which need no modifier protocol at all.
  const key: Key =
    raw.meta && raw.name === "escape"
      ? { ...raw, meta: false }
      : raw.name === "linefeed"
        ? { ...raw, name: "j", ctrl: true }
        : raw
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
      store.toast("press Ctrl-C again to quit")
    }
    return
  }

  // Esc → cancel what's in flight. NOT just `busy`: the lead turn can be idle
  // (`busy === false` — and `busy` is never set on the remote bin at all) while
  // a turn or a background fleet runs, so gate on the live PHASE machine + fleet
  // too. Treat all three as "in flight" so Esc tears it down instead of falling
  // through to focus/preview navigation (the "Esc went to the wrong place" bug).
  // Skip when the composer holds a `:`/`/` line — that Esc cancels the command
  // (handled just below), it shouldn't interrupt the run.
  const composingCommand =
    store.focus() === "input" &&
    (store.input().startsWith(":") || (store.input().startsWith("/") && store.input().length > 1))
  const inFlight =
    store.busy() || store.agentState().phase !== "idle" || store.agentState().fleet.length > 0
  if (key.name === "escape" && !composingCommand && inFlight) {
    // agy two-stage Esc: with pending messages queued, the FIRST Esc pulls them
    // ALL back into the composer to edit/cancel (and clears the queue, so they
    // don't ALSO run as the next turn); only the NEXT Esc — queue now empty —
    // interrupts the running agent.
    const pending = store.queued()
    if (pending.length > 0) {
      ctx.clearQueue()
      store.inputControl.current?.seed(pending.join("\n\n"))
      store.setFocus("input")
      store.setMode("insert")
      return
    }
    ctx.interrupt()
    return
  }

  // Esc on a `:`/`/` command line in the composer cancels the command first
  // (vim cmdline behavior) — before it could close the agent pane.
  if (key.name === "escape" && store.focus() === "input") {
    const text = store.input()
    if (text.startsWith(":") || text.startsWith("/")) {
      store.inputControl.current?.seed("")
      store.setPaletteIndex(0)
      return
    }
  }

  // Esc clears an active search first — finer-grained than closing a pane, and
  // it works from any focus (a `/` search is typed in the composer, so focus is
  // often the input when it's live).
  if (key.name === "escape" && store.search() !== undefined) {
    store.setSearch(undefined)
    return
  }

  // Esc closes the open agent (right) pane — from ANY focus, including the
  // composer (opening an agent focuses the composer so you can message it), since
  // it's the prominent thing on screen. A busy/fleet Esc stays an interrupt
  // (above). `q` closes it too, from the read-only panes.
  if (key.name === "escape" && store.nodePreview() !== undefined) {
    closeNodePreview(store)
    return
  }

  // Esc in the idle input (no agent pane) — the modifier-free way OUT of the
  // composer, for vi hands and tmux users alike (Ctrl-H never arrives in legacy
  // terminals). Leaves the draft intact and drops to NORMAL on the chat.
  if (key.name === "escape" && store.focus() === "input") {
    focusChat(store)
    return
  }

  // `Tab` (primary) cycles the three focus targets from ANY pane: input → chat →
  // tree → input. NORMAL for the read-only chat/tree panes, INSERT for the input.
  // The one exception: while the `:` command palette is open in the composer, Tab
  // COMPLETES the highlighted command (owned by `inputKey` below) — so it only
  // cycles when the palette isn't up.
  if (key.name === "tab" && !key.ctrl && !key.meta && !key.shift) {
    const buf = store.input()
    const paletteOpen =
      store.focus() === "input" && buf.startsWith(":") && !buf.includes(" ") && !buf.includes("\n")
    if (!paletteOpen) {
      key.preventDefault?.()
      const f = store.focus()
      if (f === "input") focusChat(store)
      else if (f === "chat") focusTree(store)
      else {
        store.setFocus("input")
        store.setMode("insert")
      }
      return
    }
  }

  // Pane focus aliases: chat (Ctrl-h/k/↑) · tree (Ctrl-l/→) · input (Ctrl-j/↓).
  // Read-only panes get NORMAL, the input gets INSERT.
  if (key.ctrl && (key.name === "h" || key.name === "k" || key.name === "up")) {
    focusChat(store)
    return
  }
  if (key.ctrl && (key.name === "l" || key.name === "right")) {
    focusTree(store)
    return
  }
  if (key.ctrl && (key.name === "j" || key.name === "down")) {
    store.setFocus("input")
    store.setMode("insert")
    return
  }

  // `/` in a read-only pane opens a search FOR that pane: remember which pane,
  // drop to the input, and seed the buffer with "/" so the user just types the
  // query (submit routes via `searchPane`; the tree maps to the "side" search).
  if (key.name === "/" && !key.ctrl && !key.meta && store.focus() !== "input") {
    store.setSearchPane(store.focus() === "tree" ? "side" : "conversation")
    store.setFocus("input")
    store.setMode("insert")
    store.inputControl.current?.seed("/")
    return
  }

  // `:` in a read-only pane opens the command palette — the nav row promises
  // `: cmd` from every pane, so it must work without Ctrl-J first. Same shape
  // as `/`: drop to the input and seed the prefix.
  if (key.name === ":" && !key.ctrl && !key.meta && store.focus() !== "input") {
    store.setFocus("input")
    store.setMode("insert")
    store.inputControl.current?.seed(":")
    return
  }

  // `w` in NORMAL is a modifier-free alias for the Tab cycle (chat → tree →
  // input) — for terminals that eat the Ctrl encodings, and a familiar vi path.
  if (
    key.name === "w" &&
    !key.ctrl &&
    !key.meta &&
    !key.shift &&
    store.focus() !== "input"
  ) {
    if (store.focus() === "chat") focusTree(store)
    else {
      store.setFocus("input")
      store.setMode("insert")
    }
    return
  }

  // `?` in NORMAL opens the shortcuts overlay (agy "? for shortcuts" — the
  // persistent keybind box is retired). The input handler owns `?` while typing.
  if (key.name === "?" && !key.ctrl && !key.meta && store.focus() !== "input") {
    store.setOverlay({ kind: "shortcuts" })
    return
  }

  // Input pane (INSERT): palette nav/complete/run + prompt-history recall, claimed
  // before the textarea (via preventDefault) so the right keys reach the command
  // line instead of inserting a newline / moving the cursor.
  if (store.focus() === "input" && store.overlay().kind === "none" && inputKey(ctx, key)) {
    return
  }

  // Fleet-tree pane: cursor / fold / jump-into-node over the persistent tree.
  if (!key.ctrl && !key.meta && store.focus() === "tree" && treeKey(ctx, key)) {
    return
  }

  // Chat pane: scroll / fold-all / search nav (Ctrl-D/U allowed here).
  if (!key.meta && store.focus() === "chat" && conversationKey(ctx, key)) {
    return
  }

  // `q` drops an open node-session preview from any read-only pane — the
  // always-available close (Esc is taken by interrupt while a turn runs).
  if (
    key.name === "q" &&
    !key.ctrl &&
    !key.meta &&
    store.nodePreview() !== undefined &&
    store.focus() !== "input"
  ) {
    closeNodePreview(store)
    return
  }

  // `y` yanks the current OpenTUI mouse selection to the clipboard (read-only
  // panes only; the input's textarea owns its own selection/copy).
  if (key.name === "y" && !key.ctrl && !key.meta && store.focus() !== "input") {
    ctx.copySelection()
    return
  }
}
