import { ansi, padLeft, padRight, stripAnsi, truncate, visibleLength, wrapAnsi } from "./terminal.js"
import { renderMarkdown } from "./markdown.js"

// --- vim word motions (pure, over a single plain-text line) -----------------
// class: 0 = whitespace, 1 = word char (alnum/_), 2 = punctuation. `big` (W/B/E)
// collapses 1+2 → one class, so words are whitespace-delimited.
type CharClass = 0 | 1 | 2
const classOf = (ch: string, big: boolean): CharClass => {
  if (ch === " " || ch === "\t") return 0
  if (big) return 1
  return /[A-Za-z0-9_]/.test(ch) ? 1 : 2
}

/** `w`/`W`: start of the next word after `col`, or -1 if none on this line. */
export const nextWordStart = (text: string, col: number, big: boolean): number => {
  const n = text.length
  let i = col
  if (i >= n) return -1
  const c0 = classOf(text[i]!, big)
  if (c0 !== 0) while (i < n && classOf(text[i]!, big) === c0) i++
  while (i < n && classOf(text[i]!, big) === 0) i++
  return i < n ? i : -1
}

/** `b`/`B`: start of the word at/before `col`, or -1 if none. */
export const prevWordStart = (text: string, col: number, big: boolean): number => {
  let i = col - 1
  while (i >= 0 && classOf(text[i]!, big) === 0) i--
  if (i < 0) return -1
  const c = classOf(text[i]!, big)
  while (i > 0 && classOf(text[i - 1]!, big) === c) i--
  return i
}

/** `e`/`E`: end of the next word after `col`, or -1 if none. */
export const wordEnd = (text: string, col: number, big: boolean): number => {
  const n = text.length
  let i = col + 1
  while (i < n && classOf(text[i]!, big) === 0) i++
  if (i >= n) return -1
  const c = classOf(text[i]!, big)
  while (i + 1 < n && classOf(text[i + 1]!, big) === c) i++
  return i
}

/** `^`: first non-blank column (0 if the line is all blanks/empty). */
export const firstNonBlank = (text: string): number => {
  let i = 0
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i++
  return i < text.length ? i : 0
}

/** Collapse whitespace to single spaces — for folded-section summary lines. */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim()

export type CursorOp =
  | "charLeft"
  | "charRight"
  | "lineStart"
  | "lineEnd"
  | "firstNonBlank"
  | "wordFwd"
  | "wordBack"
  | "wordEnd"
  | "wordFwdBig"
  | "wordBackBig"
  | "wordEndBig"

export type ToolPillState = "running" | "ok" | "error"

export type ScrollbackBlock =
  | { readonly kind: "user"; readonly text: string; readonly msgIndex?: number }
  | { readonly kind: "assistant"; readonly text: string; readonly msgIndex?: number }
  | { readonly kind: "reasoning"; readonly text: string; readonly msgIndex?: number }
  | {
      readonly kind: "tool"
      readonly id: string
      /** Semantic call label, e.g. `read foo.ts L1-40`. */
      readonly toolName: string
      readonly state: ToolPillState
      /** One-line result summary, e.g. `50 lines`, `+12/-3`, `exit 0`. */
      readonly detail?: string
      /** Unified diff (edit_file/write_file) — rendered colorized below the pill. */
      readonly diff?: string
      /** Full textual output (bash/grep/read) — shown when expanded. */
      readonly output?: string
      readonly msgIndex?: number
    }
  | { readonly kind: "info"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "checkpoint"; readonly text: string }

/**
 * Maps a rendered visual line back to the foldable section it belongs to (a
 * Neogit-style "commit" turn, or a tool-call group). `foldable` is false for
 * lines that are not a fold handle (so Tab is a no-op there).
 */
interface FoldRef {
  readonly id: string
  readonly foldable: boolean
}

// Claude-style event rail: a leading `●` whose COLOUR carries the signal.
// Tool bullets carry run/ok/error; assistant prose gets a calm pane-accent dot.
const STATE_COLOR: Record<ToolPillState, string> = {
  running: ansi.fgYellow,
  ok: ansi.fgGreen,
  error: ansi.fgRed,
}
const DOT = "●"
const ASSISTANT_DOT = `${ansi.fgBrightCyan}${DOT}${ansi.reset}`
// Result connector hanging under a tool's `●` (Claude's `⎿`).
const CONNECTOR = "⎿"

type DiffRow =
  | { readonly kind: "ctx" | "del" | "add"; readonly oldNo?: number; readonly newNo?: number; readonly text: string }
  | { readonly kind: "sep" }

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Render a unified diff into a line-number gutter view: old/new line columns
 * (parsed from the `@@` headers), a coloured +/-/context marker, and a subtle
 * full-width bg tint on changed lines. `--- / +++` headers are dropped; a `⋯`
 * separates non-contiguous hunks. Each output line fits within `width`.
 */
const renderDiff = (diff: string, width: number): string[] => {
  const rows: DiffRow[] = []
  let oldLn = 0
  let newLn = 0
  let maxNo = 0
  let seenHunk = false
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue
    const hm = HUNK_RE.exec(line)
    if (hm) {
      if (seenHunk) rows.push({ kind: "sep" })
      seenHunk = true
      oldLn = Number(hm[1])
      newLn = Number(hm[2])
      continue
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", oldNo: oldLn, text: line.slice(1) })
      maxNo = Math.max(maxNo, oldLn)
      oldLn++
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", newNo: newLn, text: line.slice(1) })
      maxNo = Math.max(maxNo, newLn)
      newLn++
    } else {
      rows.push({ kind: "ctx", oldNo: oldLn, newNo: newLn, text: line.startsWith(" ") ? line.slice(1) : line })
      maxNo = Math.max(maxNo, oldLn, newLn)
      oldLn++
      newLn++
    }
  }

  const numW = Math.max(2, String(maxNo).length)
  const gutterW = numW * 2 + 2 // oldCol + space + newCol + space
  const bodyW = Math.max(4, width - gutterW)
  const blank = " ".repeat(numW)

  return rows.map((r) => {
    if (r.kind === "sep") return `${ansi.dim}${" ".repeat(gutterW)}⋯${ansi.reset}`
    const oldCol = r.oldNo !== undefined ? padLeft(String(r.oldNo), numW) : blank
    const newCol = r.newNo !== undefined ? padLeft(String(r.newNo), numW) : blank
    const gutter = `${ansi.dim}${oldCol} ${newCol} ${ansi.reset}`
    const marker = r.kind === "del" ? "-" : r.kind === "add" ? "+" : " "
    // Subtle: coloured +/- text, no filled background.
    if (r.kind === "del") {
      return `${gutter}${ansi.fgRed}${truncate(marker + r.text, bodyW)}${ansi.reset}`
    }
    if (r.kind === "add") {
      return `${gutter}${ansi.fgGreen}${truncate(marker + r.text, bodyW)}${ansi.reset}`
    }
    return `${gutter}${ansi.dim}${truncate(marker + r.text, bodyW)}${ansi.reset}`
  })
}

/** Context rows kept above/below the cursor as the viewport follows it. */
const SCROLLOFF = 3

// Collapsed line caps; expanded shows up to the larger cap.
const DIFF_COLLAPSED = 8
const DIFF_EXPANDED = 200
const OUTPUT_EXPANDED = 120

const renderBlock = (
  block: ScrollbackBlock,
  cols: number,
  expanded: boolean,
): string[] => {
  switch (block.kind) {
    case "user": {
      // Dead in the stack view — flatten() routes user blocks through
      // turnHeader (the full-width bg bar). Kept consistent: no ┃ bar.
      const inner = wrapAnsi(block.text, cols - 2)
      return inner.map((l) => `  ${ansi.fgBrightGreen}${l}${ansi.reset}`)
    }
    case "reasoning": {
      // The model's externalised thinking — quiet (dim italic), capped when
      // collapsed; Ctrl-R reveals the rest.
      const body = wrapAnsi(block.text, cols - 2)
      const cap = expanded ? body.length : Math.min(body.length, 4)
      const out = body
        .slice(0, cap)
        .map(
          (l, i) =>
            `${ansi.dim}${ansi.italic}${i === 0 ? "✻ " : "  "}${l}${ansi.reset}`,
        )
      if (body.length > cap) {
        out.push(`${ansi.dim}  … ${body.length - cap} more · Ctrl-R${ansi.reset}`)
      }
      return out
    }
    case "assistant": {
      // A pane-accent `●` leads the first line; continuations align under the
      // text at a 2-space hang (the bullet + space is the same 2-col gutter).
      const body = renderMarkdown(block.text, cols - 2)
      return body.map((l, i) => (i === 0 ? `${ASSISTANT_DOT} ${l}` : `  ${l}`))
    }
    case "tool": {
      // `● Name(arg)` — the `●` colour carries run/ok/error; the result summary
      // hangs under it on a `⎿` connector line. Diff/output indent under the ⎿.
      const head = `${STATE_COLOR[block.state]}${DOT}${ansi.reset} ${block.toolName}`
      const out: string[] = [head]

      const summary =
        block.detail !== undefined && block.detail.length > 0
          ? block.detail.split("\n")[0]!
          : undefined
      if (summary !== undefined) {
        out.push(
          `  ${ansi.dim}${CONNECTOR} ${truncate(summary, Math.max(4, cols - 6))}${ansi.reset}`,
        )
      }

      // edit/write: gutter diff under the ⎿ (collapsed cap; Ctrl-R reveals all).
      if (block.diff !== undefined && block.diff.length > 0) {
        const all = renderDiff(block.diff, cols - 4)
        const cap = expanded ? DIFF_EXPANDED : DIFF_COLLAPSED
        out.push(...all.slice(0, cap).map((l) => `    ${l}`))
        if (all.length > cap) {
          out.push(`    ${ansi.dim}… ${all.length - cap} more · Ctrl-R${ansi.reset}`)
        }
        return out
      }

      // bash/grep/read full output is hidden by default — Ctrl-R reveals it.
      if (expanded && block.output !== undefined && block.output.length > 0) {
        const lines = block.output.split("\n")
        out.push(
          ...lines
            .slice(0, OUTPUT_EXPANDED)
            .map((l) => `    ${ansi.dim}${truncate(l, cols - 5)}${ansi.reset}`),
        )
        if (lines.length > OUTPUT_EXPANDED) {
          out.push(
            `    ${ansi.dim}… ${lines.length - OUTPUT_EXPANDED} more lines${ansi.reset}`,
          )
        }
      }
      return out
    }
    case "info":
      return [`${ansi.dim}${block.text}${ansi.reset}`]
    case "error":
      return [`${ansi.fgBrightRed}${DOT} ${block.text}${ansi.reset}`]
    case "checkpoint": {
      const bar = `${ansi.fgBrightMagenta}┃${ansi.reset} `
      const header = `${ansi.fgBrightMagenta}─── Handoff Checkpoint ──────────────────────────────────────────${ansi.reset}`
      const footer = `${ansi.fgBrightMagenta}─────────────────────────────────────────────────────────────────${ansi.reset}`
      const lines = wrapAnsi(block.text, cols - 4)
      return [
        "",
        header,
        ...lines.map((l) => bar + l),
        footer,
        "",
      ]
    }
  }
}

/**
 * Append-only stack of blocks. Mutated by callers (the TUI driver).
 * Renders a bottom-anchored window into the block sequence, with an
 * optional `scrollOffset` measured in visual lines — `0` = stuck to
 * the latest content; positive values reveal older content above.
 *
 * Per-block wrapped lines are memoized (keyed by block identity + cols +
 * expanded), so a keystroke / spinner tick re-flattens by concatenating
 * cached arrays instead of re-wrapping every block.
 * Navigation, search and the viewport math read fields derived from the
 * most recent render(), so callers never re-flatten or thread the size in.
 */
export class Scrollback {
  private blocks: ScrollbackBlock[] = []
  private toolIndex = new Map<string, number>()
  private scrollOffset = 0
  private expanded = false

  // --- Neogit-style folding ------------------------------------------------
  // A monotonic sequence stamped on every block at push time gives each a
  // STABLE id (surviving the object-replace in updateTool) so a section the
  // user folded stays folded as streaming pills append into it.
  private seq = 0
  private blockSeq = new WeakMap<ScrollbackBlock, number>()
  /** Folded section ids (turn ids + tool-group ids). */
  private collapsed = new Set<string>()
  /** Per visual line → the foldable section it belongs to (set by flatten). */
  private itemAtLine: (FoldRef | undefined)[] = []
  /** Message-index → first visual line, for the context-view cross-pane jump. */
  private msgIndexToLine = new Map<number, number>()
  /** Every foldable section id seen in the last flatten (for fold/unfold all). */
  private foldableIds: string[] = []

  // Snapshot of the last render — drives nav/search without re-flattening.
  private viewportRows = 0
  private totalVisualLines = 0
  private flatLines: string[] = []
  private msgStartLines: number[] = []

  // Active search (vim `/`): `searchQuery` highlights matches in the window;
  // `matchLines` holds absolute visual-line indices for n/N navigation.
  private searchQuery = ""
  private matchLines: number[] = []
  private matchIdx = 0

  // The persistent cursor (absolute visual-line index). It is the single
  // "where am I" anchor in BOTH NORMAL and VISUAL — every motion moves it and
  // the viewport follows (see followCursor). `cursorActive` distinguishes a
  // meaningfully-placed cursor from a fresh / just-cleared buffer (which
  // follow-tails); the driver calls initCursor() on focus-in to place it.
  private cursorLine = 0
  // The cursor's column (visible cell index within its flat line) — this plus
  // `cursorLine` is the real, nvim-style block-cursor position the driver
  // renders with the hardware cursor. `desiredCol` is the remembered column so
  // j/k keep the column over ragged lines (vim behaviour); `$` parks it at
  // Infinity so vertical motion sticks to line ends.
  private cursorCol = 0
  private desiredCol = 0
  private cursorActive = false

  // VISUAL selection: `anchorLine`/`anchorCol` is the fixed end, the cursor the
  // moving end. `visualKind` is charwise (`v`) or linewise (`V`); `y` yanks the
  // ordered range to the clipboard.
  private selecting = false
  private visualKind: "char" | "line" = "char"
  private anchorLine = 0
  private anchorCol = 0

  private lineCache = new WeakMap<
    ScrollbackBlock,
    { cols: number; expanded: boolean; lines: ReadonlyArray<string> }
  >()

  push(block: ScrollbackBlock): void {
    if (block.kind === "tool") {
      this.toolIndex.set(block.id, this.blocks.length)
    }
    this.blockSeq.set(block, this.seq++)
    this.blocks.push(block)
  }

  updateTool(
    id: string,
    patch: {
      state?: ToolPillState
      detail?: string
      diff?: string
      output?: string
    },
  ): void {
    const idx = this.toolIndex.get(id)
    if (idx === undefined) return
    const cur = this.blocks[idx]
    if (cur === undefined || cur.kind !== "tool") return
    // A fresh object → the line cache misses for this block only (its old
    // key is gone), so the pill re-renders while every other block stays cached.
    const next: ScrollbackBlock = {
      ...cur,
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.diff !== undefined ? { diff: patch.diff } : {}),
      ...(patch.output !== undefined ? { output: patch.output } : {}),
    }
    // Carry the stable seq onto the replacement so its fold/group id is unchanged.
    const oldSeq = this.blockSeq.get(cur)
    if (oldSeq !== undefined) this.blockSeq.set(next, oldSeq)
    this.blocks[idx] = next
  }

  /** Toggle full diff/output rendering for tool blocks (Ctrl-R). */
  toggleExpanded(): boolean {
    this.expanded = !this.expanded
    return this.expanded
  }

  clear(): void {
    this.blocks = []
    this.toolIndex.clear()
    this.scrollOffset = 0
    this.totalVisualLines = 0
    this.flatLines = []
    this.msgStartLines = []
    this.selecting = false
    this.cursorLine = 0
    this.cursorCol = 0
    this.desiredCol = 0
    this.cursorActive = false
    this.seq = 0
    this.collapsed.clear()
    this.itemAtLine = []
    this.msgIndexToLine.clear()
    this.foldableIds = []
    this.clearSearch()
  }

  // --- folding API (driven by Tab / zR / zM) ------------------------------

  /** Stable id for a block (tool keeps its own id; others use the seq). */
  private idOf(block: ScrollbackBlock): string {
    if (block.kind === "tool") return `t:${block.id}`
    return `b:${this.blockSeq.get(block) ?? -1}`
  }

  /** Tab/Enter: fold or unfold the section under the cursor (no-op elsewhere). */
  foldToggleAtCursor(): void {
    const ref = this.itemAtLine[this.cursorLine]
    if (ref === undefined || !ref.foldable) return
    // Land the cursor on the section's first (header) line, which folding never
    // moves — so the cursor stays put as the body collapses below it.
    let first = this.cursorLine
    while (first > 0 && this.itemAtLine[first - 1]?.id === ref.id) first--
    this.cursorLine = first
    this.cursorCol = 0
    this.desiredCol = 0
    if (this.collapsed.has(ref.id)) this.collapsed.delete(ref.id)
    else this.collapsed.add(ref.id)
  }

  /** Z: unfold or fold every section. */
  setAllFolded(folded: boolean): void {
    if (folded) for (const id of this.foldableIds) this.collapsed.add(id)
    else this.collapsed.clear()
  }

  /** Whether any section is currently folded (drives the Z toggle). */
  anyFolded(): boolean {
    return this.collapsed.size > 0
  }

  /**
   * Move the cursor to the first visual line of message `i` (a context-view
   * jump target). Returns false if that message isn't in the current buffer.
   */
  cursorToMessageIndex(i: number): boolean {
    const line = this.msgIndexToLine.get(i)
    if (line === undefined) return false
    this.cursorActive = true
    this.cursorLine = line
    this.cursorCol = 0
    this.desiredCol = 0
    this.followCursor()
    return true
  }

  // --- viewport scrolling -------------------------------------------------

  private maxOffset(): number {
    return Math.max(0, this.totalVisualLines - this.viewportRows)
  }

  private clampOffset(): void {
    if (this.scrollOffset < 0) this.scrollOffset = 0
    const max = this.maxOffset()
    if (this.scrollOffset > max) this.scrollOffset = max
  }

  /** Shift the view by `delta` visual lines (positive = older content). */
  scrollBy(delta: number): void {
    this.scrollOffset += delta
    this.clampOffset()
  }

  /** Snap back to the bottom (newest content). */
  stickToBottom(): void {
    this.scrollOffset = 0
  }

  isAtBottom(): boolean {
    return this.scrollOffset === 0
  }

  /** Total visual lines from the most recent render — used by the driver. */
  totalLines(): number {
    return this.totalVisualLines
  }

  private pageStep(): number {
    return Math.max(5, Math.floor(this.viewportRows * 0.75))
  }
  private halfStep(): number {
    return Math.max(1, Math.floor(this.viewportRows / 2))
  }

  /** First visible (top) absolute line index for the current offset. */
  private topLine(): number {
    return Math.max(0, this.totalVisualLines - this.scrollOffset - this.viewportRows)
  }

  /** Scroll so absolute visual line `idx` sits at the top of the viewport. */
  private alignTop(idx: number): void {
    this.scrollOffset = this.totalVisualLines - this.viewportRows - idx
    this.clampOffset()
  }

  // --- cursor (NORMAL + VISUAL) -------------------------------------------

  /** Largest valid cursor index (0 when empty). */
  private maxCursor(): number {
    return Math.max(0, this.totalVisualLines - 1)
  }

  private clampCursor(): void {
    if (this.cursorLine < 0) this.cursorLine = 0
    const max = this.maxCursor()
    if (this.cursorLine > max) this.cursorLine = max
  }

  /** Visible length of a flat line (0 if out of range). */
  private lineLen(idx: number): number {
    const l = this.flatLines[idx]
    return l === undefined ? 0 : visibleLength(l)
  }
  /** Largest valid column on a line (0 on an empty line). */
  private lastCol(idx: number): number {
    return Math.max(0, this.lineLen(idx) - 1)
  }
  private clampCol(): void {
    const max = this.lastCol(this.cursorLine)
    if (this.cursorCol > max) this.cursorCol = max
    if (this.cursorCol < 0) this.cursorCol = 0
  }
  /** Reconcile the column from the remembered desired column (vim j/k). */
  private applyDesiredCol(): void {
    const max = this.lastCol(this.cursorLine)
    this.cursorCol = Math.min(this.desiredCol, max)
    if (this.cursorCol < 0) this.cursorCol = 0
  }

  /**
   * Adjust the viewport so the cursor stays visible with a scrolloff margin.
   * The margin is *desired*, not forced: `alignTop`→`clampOffset` caps the
   * offset, so the cursor only ever touches the true top/bottom edges.
   */
  private followCursor(): void {
    this.clampCursor()
    this.clampCol()
    if (this.totalVisualLines <= this.viewportRows) {
      this.scrollOffset = 0
      return
    }
    const so = Math.min(SCROLLOFF, Math.floor((this.viewportRows - 1) / 2))
    const top = this.topLine()
    if (this.cursorLine < top + so) {
      this.alignTop(this.cursorLine - so)
    } else if (this.cursorLine > top + this.viewportRows - 1 - so) {
      this.alignTop(this.cursorLine - this.viewportRows + 1 + so)
    }
  }

  /**
   * Idempotently place the cursor if it was never meaningfully positioned
   * (fresh / just-cleared buffer): park it on the newest line so `k` walks
   * back into history. A cursor already placed is left where it is — so it
   * persists across focus changes.
   */
  initCursor(): void {
    if (this.cursorActive) return
    this.cursorActive = true
    this.cursorLine = this.maxCursor()
    this.followCursor()
  }

  /** Absolute cursor line — for the driver / tests. */
  cursorIndex(): number {
    return this.cursorLine
  }

  /** j / k — move the cursor one line, keeping the desired column (viewport follows). */
  moveCursor(delta: number): void {
    this.cursorActive = true
    this.cursorLine += delta
    this.clampCursor()
    this.applyDesiredCol()
    this.followCursor()
  }
  /** gg — cursor to the oldest line. */
  cursorToTop(): void {
    this.cursorActive = true
    this.cursorLine = 0
    this.applyDesiredCol()
    this.followCursor()
  }
  /** G — cursor to the newest line (re-engages follow-tail). */
  cursorToBottom(): void {
    this.cursorActive = true
    this.cursorLine = this.maxCursor()
    this.applyDesiredCol()
    this.followCursor()
  }

  // --- horizontal + word motions (the nvim block cursor) ------------------

  /** h / l — one cell left/right, remembering the new desired column. */
  cursorCharLeft(): void {
    this.cursorActive = true
    this.cursorCol = Math.max(0, this.cursorCol - 1)
    this.desiredCol = this.cursorCol
  }
  cursorCharRight(): void {
    this.cursorActive = true
    this.cursorCol = Math.min(this.lastCol(this.cursorLine), this.cursorCol + 1)
    this.desiredCol = this.cursorCol
  }
  /** 0 — first column. */
  cursorLineStart(): void {
    this.cursorActive = true
    this.cursorCol = 0
    this.desiredCol = 0
  }
  /** $ — last column; parks desiredCol at the end so j/k stick to line ends. */
  cursorLineEnd(): void {
    this.cursorActive = true
    this.cursorCol = this.lastCol(this.cursorLine)
    this.desiredCol = Number.MAX_SAFE_INTEGER
  }
  /** ^ — first non-blank column. */
  cursorFirstNonBlank(): void {
    this.cursorActive = true
    const col = firstNonBlank(stripAnsi(this.flatLines[this.cursorLine] ?? ""))
    this.cursorCol = col
    this.desiredCol = col
  }
  /**
   * w/W/b/B/e/E — word motions on the current line; when there's no target on
   * the line they spill to the adjacent line (vim-ish) so the cursor never gets
   * stuck at a line boundary.
   */
  cursorWord(kind: "fwd" | "back" | "end", big: boolean): void {
    this.cursorActive = true
    const text = stripAnsi(this.flatLines[this.cursorLine] ?? "")
    if (kind === "fwd") {
      const i = nextWordStart(text, this.cursorCol, big)
      if (i >= 0) this.cursorCol = i
      else if (this.cursorLine < this.maxCursor()) {
        this.cursorLine++
        const t = stripAnsi(this.flatLines[this.cursorLine] ?? "")
        this.cursorCol = firstNonBlank(t)
      } else this.cursorCol = this.lastCol(this.cursorLine)
    } else if (kind === "back") {
      const i = prevWordStart(text, this.cursorCol, big)
      if (i >= 0) this.cursorCol = i
      else if (this.cursorLine > 0) {
        this.cursorLine--
        const t = stripAnsi(this.flatLines[this.cursorLine] ?? "")
        const j = prevWordStart(t, t.length, big)
        this.cursorCol = j >= 0 ? j : 0
      } else this.cursorCol = 0
    } else {
      const i = wordEnd(text, this.cursorCol, big)
      if (i >= 0) this.cursorCol = i
      else if (this.cursorLine < this.maxCursor()) {
        this.cursorLine++
        const t = stripAnsi(this.flatLines[this.cursorLine] ?? "")
        const j = wordEnd(t, -1, big)
        this.cursorCol = j >= 0 ? j : 0
      } else this.cursorCol = this.lastCol(this.cursorLine)
    }
    this.clampCol()
    this.desiredCol = this.cursorCol
    this.followCursor()
  }
  /** Ctrl-U / Ctrl-D — half a screen. */
  cursorHalfUp(): void {
    this.moveCursor(-this.halfStep())
  }
  cursorHalfDown(): void {
    this.moveCursor(this.halfStep())
  }
  /** PgUp / PgDn — ~75% of a screen. */
  cursorPageUp(): void {
    this.moveCursor(-this.pageStep())
  }
  cursorPageDown(): void {
    this.moveCursor(this.pageStep())
  }

  /** { / } — hop the cursor to the previous / next message boundary. */
  cursorToMessage(dir: "up" | "down"): void {
    const starts = this.msgStartLines
    if (starts.length === 0) return
    this.cursorActive = true
    const cur = this.cursorLine
    if (dir === "up") {
      // The last boundary strictly above the cursor (else the first one).
      let target = starts[0]!
      for (const s of starts) {
        if (s < cur) target = s
        else break
      }
      this.cursorLine = target
    } else {
      const next = starts.find((s) => s > cur)
      this.cursorLine = next ?? starts[starts.length - 1]!
    }
    this.applyDesiredCol()
    this.followCursor()
  }

  /**
   * Window-relative row (0-based, within the visible viewport) of the cursor
   * line, or -1 when it's off-screen. Works in NORMAL and VISUAL — the driver
   * maps it to a screen row (VISUAL hardware cursor) and render.ts uses it to
   * place the gutter caret.
   */
  cursorRow(): number {
    if (!this.cursorActive) return -1
    const row = this.cursorLine - this.topLine()
    return row >= 0 && row < this.viewportRows ? row : -1
  }

  /** The cursor's visible column within its line — for the hardware block cursor. */
  cursorVisibleCol(): number {
    return this.cursorCol
  }

  // --- search (vim `/`) ---------------------------------------------------

  /** Recompute match lines for the active query, preserving the cursor. */
  private recomputeMatches(): void {
    this.matchLines = []
    const q = this.searchQuery.toLowerCase()
    if (q.length === 0) {
      this.matchIdx = 0
      return
    }
    for (let i = 0; i < this.flatLines.length; i++) {
      if (stripAnsi(this.flatLines[i]!).toLowerCase().includes(q)) {
        this.matchLines.push(i)
      }
    }
    if (this.matchIdx >= this.matchLines.length) {
      this.matchIdx = Math.max(0, this.matchLines.length - 1)
    }
  }

  /** Set the query (resets to the first match). Returns the match count. */
  search(query: string): number {
    this.searchQuery = query
    this.matchIdx = 0
    this.recomputeMatches()
    return this.matchLines.length
  }

  clearSearch(): void {
    this.searchQuery = ""
    this.matchLines = []
    this.matchIdx = 0
  }

  /** Move the cursor onto the current match (no-op if there are none). */
  jumpToMatch(): void {
    if (this.matchLines.length === 0) return
    this.cursorActive = true
    this.cursorLine = this.matchLines[this.matchIdx]!
    // Land on the match column (vim-like), not just the line.
    const col = stripAnsi(this.flatLines[this.cursorLine] ?? "")
      .toLowerCase()
      .indexOf(this.searchQuery.toLowerCase())
    this.cursorCol = col >= 0 ? col : 0
    this.desiredCol = this.cursorCol
    this.followCursor()
  }

  /** n / N — advance to the next / previous match and put the cursor on it. */
  nextMatch(dir: "next" | "prev"): void {
    const n = this.matchLines.length
    if (n === 0) return
    this.matchIdx =
      dir === "next" ? (this.matchIdx + 1) % n : (this.matchIdx - 1 + n) % n
    this.jumpToMatch()
  }

  /** Whether a query is active (highlights shown, n/N navigable). */
  searchActive(): boolean {
    return this.searchQuery.length > 0
  }

  /** For the search bar `[i/total]` readout. */
  matchInfo(): { readonly index: number; readonly total: number } {
    return {
      index: this.matchLines.length === 0 ? 0 : this.matchIdx + 1,
      total: this.matchLines.length,
    }
  }

  // --- VISUAL selection ---------------------------------------------------

  /**
   * Enter line-wise VISUAL mode, anchored at the *current cursor* (not the
   * viewport top) — so selection extends from where you already are. The
   * cursor motions (moveCursor / cursorTo* / cursorToMessage) double as the
   * selection-extend verbs, since selRange() reads anchor + cursor.
   */
  startVisual(kind: "char" | "line" = "char"): void {
    this.cursorActive = true
    this.selecting = true
    this.visualKind = kind
    this.anchorLine = this.cursorLine
    this.anchorCol = this.cursorCol
  }
  endVisual(): void {
    this.selecting = false
  }
  isSelecting(): boolean {
    return this.selecting
  }
  visualMode(): "char" | "line" {
    return this.visualKind
  }

  /** Ordered line-wise bounds (for linewise selection + the line count). */
  private selRange(): readonly [number, number] {
    return this.anchorLine <= this.cursorLine
      ? [this.anchorLine, this.cursorLine]
      : [this.cursorLine, this.anchorLine]
  }
  /** Ordered (line,col) endpoints for charwise selection. */
  private selOrdered(): {
    readonly loL: number
    readonly loC: number
    readonly hiL: number
    readonly hiC: number
  } {
    const a = { l: this.anchorLine, c: this.anchorCol }
    const b = { l: this.cursorLine, c: this.cursorCol }
    const aFirst = a.l < b.l || (a.l === b.l && a.c <= b.c)
    const lo = aFirst ? a : b
    const hi = aFirst ? b : a
    return { loL: lo.l, loC: lo.c, hiL: hi.l, hiC: hi.c }
  }
  selectionLineCount(): number {
    const [a, b] = this.selRange()
    return b - a + 1
  }
  /** The selection as plain text (ANSI stripped), for yanking. */
  selectionText(): string {
    if (this.visualKind === "line") {
      const [a, b] = this.selRange()
      return this.flatLines.slice(a, b + 1).map(stripAnsi).join("\n")
    }
    const { loL, loC, hiL, hiC } = this.selOrdered()
    if (loL === hiL) {
      return stripAnsi(this.flatLines[loL] ?? "").slice(loC, hiC + 1)
    }
    const out: string[] = []
    for (let i = loL; i <= hiL; i++) {
      const t = stripAnsi(this.flatLines[i] ?? "")
      if (i === loL) out.push(t.slice(loC))
      else if (i === hiL) out.push(t.slice(0, hiC + 1))
      else out.push(t)
    }
    return out.join("\n")
  }

  // --- rendering ----------------------------------------------------------

  private blockLines(block: ScrollbackBlock, cols: number): ReadonlyArray<string> {
    const cached = this.lineCache.get(block)
    if (
      cached !== undefined &&
      cached.cols === cols &&
      cached.expanded === this.expanded
    ) {
      return cached.lines
    }
    const lines = renderBlock(block, cols, this.expanded)
    this.lineCache.set(block, { cols, expanded: this.expanded, lines })
    return lines
  }

  /**
   * A Neogit-style turn ("commit") header — the user prompt led by a gray fold
   * chevron (`▾` open / `▸` folded) in bright-green bold (the user/input accent).
   * Foldable via its `ref` in flatten(); folded shows a trailing `· N steps`.
   * The `chevron + space` prefix is the same 2-col gutter as the event rail.
   */
  private turnHeader(
    text: string,
    cols: number,
    folded: boolean,
    childCount: number,
  ): string[] {
    const chevron = `${ansi.fgGray}${folded ? "▸" : "▾"}${ansi.reset}`
    const style = `${ansi.fgBrightGreen}${ansi.bold}`
    if (folded) {
      const countPlain =
        childCount > 0
          ? ` · ${childCount} step${childCount === 1 ? "" : "s"}`
          : ""
      const subj = truncate(
        oneLine(text),
        Math.max(1, cols - 2 - visibleLength(countPlain)),
      )
      return [`${chevron} ${style}${subj}${ansi.reset}${ansi.dim}${countPlain}${ansi.reset}`]
    }
    const wrapped = wrapAnsi(text, cols - 2)
    return wrapped.map((l, i) =>
      i === 0
        ? `${chevron} ${style}${l}${ansi.reset}`
        : `  ${style}${l}${ansi.reset}`,
    )
  }

  /**
   * Flatten blocks into visual lines (memoized per block) as a Neogit-style
   * section tree: each user-led TURN is a foldable "commit"; runs of ≥2 tool
   * calls inside it fold into one group line. Also records, at post-fold
   * positions: `msgStarts` (turn/assistant starts, for `{`/`}`), `itemAtLine`
   * (line → foldable section, for Tab), `msgIndexToLine` (jump targets) and
   * `foldableIds` (for fold/unfold-all).
   */
  private flatten(cols: number): { lines: string[]; msgStarts: number[] } {
    const lines: string[] = []
    const msgStarts: number[] = []
    const itemAtLine: (FoldRef | undefined)[] = []
    const msgIndexToLine = new Map<number, number>()
    const foldableIds: string[] = []

    const push = (line: string, ref?: FoldRef): void => {
      lines.push(line)
      itemAtLine.push(ref)
    }
    const gap = (): void => {
      if (lines.length > 0 && lines[lines.length - 1] !== "") push("")
    }
    const recordMsg = (block: ScrollbackBlock): void => {
      if (block.kind === "info" || block.kind === "error" || block.kind === "checkpoint") {
        return
      }
      if (block.msgIndex !== undefined && !msgIndexToLine.has(block.msgIndex)) {
        msgIndexToLine.set(block.msgIndex, lines.length)
      }
    }

    // Emit a turn body (or loose run): tool runs of ≥2 fold into a group; other
    // blocks render plain, each separated by a blank line.
    const emitBody = (body: ScrollbackBlock[]): void => {
      let k = 0
      while (k < body.length) {
        const b = body[k]!
        if (b.kind === "tool") {
          let m = k + 1
          while (m < body.length && body[m]!.kind === "tool") m++
          const run = body.slice(k, m)
          if (run.length >= 2) {
            const gid = `grp:${this.idOf(run[0]!)}`
            foldableIds.push(gid)
            const ref: FoldRef = { id: gid, foldable: true }
            gap()
            if (this.collapsed.has(gid)) {
              push(`${ansi.fgGray}▸${ansi.reset} ${ansi.dim}${run.length} tool calls${ansi.reset}`, ref)
            } else {
              push(`${ansi.fgGray}▾${ansi.reset} ${ansi.dim}${run.length} tool calls${ansi.reset}`, ref)
              for (const t of run) {
                recordMsg(t)
                const tref: FoldRef = { id: this.idOf(t), foldable: false }
                for (const l of this.blockLines(t, cols)) push(l, tref)
              }
            }
            k = m
            continue
          }
          gap()
          recordMsg(b)
          const tref: FoldRef = { id: this.idOf(b), foldable: false }
          for (const l of this.blockLines(b, cols)) push(l, tref)
          k++
          continue
        }
        gap()
        if (b.kind === "assistant") msgStarts.push(lines.length)
        recordMsg(b)
        const ref: FoldRef = { id: this.idOf(b), foldable: false }
        for (const l of this.blockLines(b, cols)) push(l, ref)
        k++
      }
    }

    let i = 0
    while (i < this.blocks.length) {
      const block = this.blocks[i]!
      if (block.kind === "user") {
        let j = i + 1
        while (
          j < this.blocks.length &&
          this.blocks[j]!.kind !== "user" &&
          this.blocks[j]!.kind !== "checkpoint"
        ) {
          j++
        }
        const body = this.blocks.slice(i + 1, j)
        const tid = `turn:${this.blockSeq.get(block) ?? i}`
        foldableIds.push(tid)
        const folded = this.collapsed.has(tid)
        const ref: FoldRef = { id: tid, foldable: true }
        gap()
        msgStarts.push(lines.length)
        recordMsg(block)
        for (const l of this.turnHeader(block.text, cols, folded, body.length)) {
          push(l, ref)
        }
        if (!folded) emitBody(body)
        i = j
      } else if (block.kind === "checkpoint") {
        const ref: FoldRef = { id: this.idOf(block), foldable: false }
        for (const l of this.blockLines(block, cols)) push(l, ref)
        i++
      } else {
        // Loose run outside any turn (leading content, or right after a fold).
        let j = i
        while (
          j < this.blocks.length &&
          this.blocks[j]!.kind !== "user" &&
          this.blocks[j]!.kind !== "checkpoint"
        ) {
          j++
        }
        emitBody(this.blocks.slice(i, j))
        i = j
      }
    }
    if (lines.length > 0) push("")

    this.itemAtLine = itemAtLine
    this.msgIndexToLine = msgIndexToLine
    this.foldableIds = foldableIds
    return { lines, msgStarts }
  }

  /** Inverse-highlight every occurrence of the active query within a line. */
  private highlight(line: string): string {
    const q = this.searchQuery.toLowerCase()
    const plain = stripAnsi(line)
    const lower = plain.toLowerCase()
    if (!lower.includes(q)) return line
    let out = ""
    let i = 0
    for (;;) {
      const idx = lower.indexOf(q, i)
      if (idx === -1) {
        out += plain.slice(i)
        break
      }
      out +=
        plain.slice(i, idx) +
        ansi.inverse +
        plain.slice(idx, idx + q.length) +
        ansi.reset
      i = idx + q.length
    }
    return out
  }

  render(rows: number, cols: number, focused = false): string[] {
    this.viewportRows = rows

    // Was the cursor riding the tail as of the *previous* frame? (Also true
    // for a fresh / input-focused buffer that never placed a cursor.)
    const wasAtTail =
      !this.cursorActive || this.cursorLine >= this.totalVisualLines - 1
    const prevTotal = this.totalVisualLines

    const { lines, msgStarts } = this.flatten(cols)
    this.flatLines = lines
    this.msgStartLines = msgStarts
    this.totalVisualLines = lines.length

    // Keep matches current if the buffer grew under an active query (streamed
    // lines, tool updates) — preserves the n/N cursor.
    if (this.searchQuery.length > 0) this.recomputeMatches()

    if (wasAtTail) {
      // Ride the newest line so streaming content stays in view.
      this.cursorLine = this.maxCursor()
    } else if (this.totalVisualLines > prevTotal) {
      // Content appended below a parked cursor: bump the bottom-relative offset
      // by the growth so the absolute viewport (and the cursor's screen row)
      // stays put instead of being yanked toward the new tail.
      this.scrollOffset += this.totalVisualLines - prevTotal
    }
    this.followCursor()

    const showCursor = focused && this.cursorActive
    const lineSel = this.selecting && this.visualKind === "line"
    const [selLo, selHi] = lineSel ? this.selRange() : [-1, -1]
    const ord =
      this.selecting && this.visualKind === "char" ? this.selOrdered() : undefined
    const decorate = (l: string, absIdx: number): string => {
      let s = this.searchQuery.length > 0 ? this.highlight(l) : l
      let inSel = false
      if (lineSel && absIdx >= selLo && absIdx <= selHi) {
        // Line-wise selection: invert the whole row (drops other styling).
        s = `${ansi.inverse}${stripAnsi(s)}${ansi.reset}`
        inSel = true
      } else if (ord !== undefined && absIdx >= ord.loL && absIdx <= ord.hiL) {
        // Char-wise selection: invert only the spanned cells on this row.
        const plain = stripAnsi(l)
        const last = Math.max(0, plain.length - 1)
        let c0 = 0
        let c1 = last
        if (ord.loL === ord.hiL) {
          c0 = ord.loC
          c1 = ord.hiC
        } else if (absIdx === ord.loL) {
          c0 = ord.loC
        } else if (absIdx === ord.hiL) {
          c1 = ord.hiC
        }
        c0 = Math.max(0, Math.min(c0, plain.length))
        c1 = Math.max(c0 - 1, Math.min(c1, last))
        s =
          plain.slice(0, c0) +
          ansi.inverse +
          plain.slice(c0, c1 + 1) +
          ansi.reset +
          plain.slice(c1 + 1)
        inSel = true
      }
      s = padRight(truncate(s, cols), cols)
      if (showCursor && absIdx === this.cursorLine && !inSel) {
        // Tint the whole row; re-inject the bg after every inner reset so the
        // line's own colours survive under the cursor highlight.
        s =
          ansi.bgCursorLine +
          s.split(ansi.reset).join(ansi.reset + ansi.bgCursorLine) +
          ansi.reset
      }
      return s
    }

    if (lines.length <= rows) {
      this.scrollOffset = 0
      const window = lines.slice()
      while (window.length < rows) window.push("")
      return window.map((l, i) => decorate(l, i))
    }

    this.clampOffset()
    const end = lines.length - this.scrollOffset
    const start = Math.max(0, end - rows)
    const window = lines.slice(start, end)

    // Independent above/below indicators: hidden content above shows at the
    // top, hidden content below at the bottom.
    if (start > 0) {
      window[0] = `${ansi.dim}↑ ${start} more above${ansi.reset}`
    }
    if (this.scrollOffset > 0) {
      window[window.length - 1] =
        `${ansi.dim}${ansi.fgYellow}↓ ${this.scrollOffset} more below · G to follow${ansi.reset}`
    }

    while (window.length < rows) window.push("")
    return window.map((l, i) => decorate(l, start + i))
  }
}
