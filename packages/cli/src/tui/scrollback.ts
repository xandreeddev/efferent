import { ansi, padLeft, padRight, stripAnsi, truncate, wrapAnsi } from "./terminal.js"
import { renderMarkdown } from "./markdown.js"

export type ToolPillState = "running" | "ok" | "error"

export type ScrollbackBlock =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
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
    }
  | { readonly kind: "info"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }

const STATE_DOT: Record<ToolPillState, string> = {
  running: `${ansi.fgYellow}⏺${ansi.reset}`,
  ok: `${ansi.fgGreen}⏺${ansi.reset}`,
  error: `${ansi.fgRed}⏺${ansi.reset}`,
}

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
    if (r.kind === "del") {
      return `${gutter}${ansi.bgDiffDel}${ansi.fgRed}${padRight(truncate(marker + r.text, bodyW), bodyW)}${ansi.reset}`
    }
    if (r.kind === "add") {
      return `${gutter}${ansi.bgDiffAdd}${ansi.fgGreen}${padRight(truncate(marker + r.text, bodyW), bodyW)}${ansi.reset}`
    }
    return `${gutter}${ansi.dim}${truncate(marker + r.text, bodyW)}${ansi.reset}`
  })
}

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
      const prefix = `${ansi.fgBrightGreen}>${ansi.reset} `
      const inner = wrapAnsi(block.text, cols - 2)
      return inner.map((l, i) => (i === 0 ? prefix + l : "  " + l))
    }
    case "assistant": {
      // Prefix the first line with a marker so prose anchors to the
      // conversation spine; continuation lines indent to stay aligned.
      const body = renderMarkdown(block.text, cols - 2)
      return body.map((l, i) =>
        i === 0 ? `${ansi.fgBrightCyan}●${ansi.reset} ${l}` : `  ${l}`,
      )
    }
    case "tool": {
      // One compact pill line — the result count folds in dim onto the label,
      // so navigational tools (ls/glob/read/grep) stay a single quiet line.
      const summary =
        block.detail !== undefined && block.detail.length > 0
          ? block.detail.split("\n")[0]!
          : undefined
      const detailW = Math.max(4, cols - block.toolName.length - 5)
      const head =
        summary !== undefined
          ? `${STATE_DOT[block.state]} ${block.toolName}  ${ansi.dim}${truncate(summary, detailW)}${ansi.reset}`
          : `${STATE_DOT[block.state]} ${block.toolName}`
      const out: string[] = [head]

      // edit/write: gutter diff under the pill (collapsed cap; Ctrl-R reveals all).
      if (block.diff !== undefined && block.diff.length > 0) {
        const all = renderDiff(block.diff, cols - 5)
        const cap = expanded ? DIFF_EXPANDED : DIFF_COLLAPSED
        out.push(...all.slice(0, cap).map((l) => `     ${l}`))
        if (all.length > cap) {
          out.push(`     ${ansi.dim}… ${all.length - cap} more · Ctrl-R${ansi.reset}`)
        }
        return out
      }

      // bash/grep/read full output is hidden by default — Ctrl-R reveals it.
      if (expanded && block.output !== undefined && block.output.length > 0) {
        const lines = block.output.split("\n")
        out.push(
          ...lines
            .slice(0, OUTPUT_EXPANDED)
            .map((l) => `     ${ansi.dim}${truncate(l, cols - 6)}${ansi.reset}`),
        )
        if (lines.length > OUTPUT_EXPANDED) {
          out.push(
            `     ${ansi.dim}… ${lines.length - OUTPUT_EXPANDED} more lines${ansi.reset}`,
          )
        }
      }
      return out
    }
    case "info":
      return [`${ansi.dim}${block.text}${ansi.reset}`]
    case "error":
      return [`${ansi.fgBrightRed}${block.text}${ansi.reset}`]
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
 * cached arrays instead of re-wrapping every block (SCROLLING_REVIEW.md §C).
 * Navigation, search and the viewport math read fields derived from the
 * most recent render(), so callers never re-flatten or thread the size in.
 */
export class Scrollback {
  private blocks: ScrollbackBlock[] = []
  private toolIndex = new Map<string, number>()
  private scrollOffset = 0
  private expanded = false

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

  // VISUAL selection (line-wise): an anchor + a moving cursor, both absolute
  // visual-line indices. `y` yanks the [min,max] range to the clipboard.
  private selecting = false
  private anchorLine = 0
  private cursorLine = 0

  private lineCache = new WeakMap<
    ScrollbackBlock,
    { cols: number; expanded: boolean; lines: ReadonlyArray<string> }
  >()

  push(block: ScrollbackBlock): void {
    if (block.kind === "tool") {
      this.toolIndex.set(block.id, this.blocks.length)
    }
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
    this.blocks[idx] = {
      ...cur,
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
      ...(patch.diff !== undefined ? { diff: patch.diff } : {}),
      ...(patch.output !== undefined ? { output: patch.output } : {}),
    }
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
    this.clearSearch()
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

  /** gg / G — jump to the oldest / newest content. */
  toTop(): void {
    this.scrollOffset = this.maxOffset()
  }
  toBottom(): void {
    this.scrollOffset = 0
  }

  /** j / k — one line toward newer / older content. */
  lineDown(n = 1): void {
    this.scrollBy(-n)
  }
  lineUp(n = 1): void {
    this.scrollBy(n)
  }

  /** PgUp / PgDn — responsive step, ~75% of a screen (SCROLLING_REVIEW.md §B). */
  private pageStep(): number {
    return Math.max(5, Math.floor(this.viewportRows * 0.75))
  }
  pageUp(): void {
    this.scrollBy(this.pageStep())
  }
  pageDown(): void {
    this.scrollBy(-this.pageStep())
  }

  /** Ctrl-U / Ctrl-D — half a screen. */
  private halfStep(): number {
    return Math.max(1, Math.floor(this.viewportRows / 2))
  }
  halfUp(): void {
    this.scrollBy(this.halfStep())
  }
  halfDown(): void {
    this.scrollBy(-this.halfStep())
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

  /** Scroll so absolute visual line `idx` sits centered in the viewport. */
  private center(idx: number): void {
    this.alignTop(idx - Math.floor(this.viewportRows / 2))
  }

  /** { / } — hop to the previous / next user|assistant message boundary. */
  jumpMessage(dir: "up" | "down"): void {
    const starts = this.msgStartLines
    if (starts.length === 0) return
    const top = this.topLine()
    if (dir === "up") {
      let target = starts[0]!
      for (const s of starts) {
        if (s < top) target = s
        else break
      }
      this.alignTop(target)
    } else {
      const next = starts.find((s) => s > top)
      this.alignTop(next ?? starts[starts.length - 1]!)
    }
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

  /** Center the current match in the viewport (no-op if there are none). */
  jumpToMatch(): void {
    if (this.matchLines.length === 0) return
    this.center(this.matchLines[this.matchIdx]!)
  }

  /** n / N — advance to the next / previous match and center it. */
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

  /** Enter line-wise VISUAL mode, anchored at the current top visible line. */
  startVisual(): void {
    this.selecting = true
    this.cursorLine = this.topLine()
    this.anchorLine = this.cursorLine
  }
  endVisual(): void {
    this.selecting = false
  }
  isSelecting(): boolean {
    return this.selecting
  }

  private ensureCursorVisible(): void {
    const top = this.topLine()
    if (this.cursorLine < top) this.alignTop(this.cursorLine)
    else if (this.cursorLine >= top + this.viewportRows) {
      this.alignTop(this.cursorLine - this.viewportRows + 1)
    }
  }

  /** Move the selection cursor by `delta` lines (extends the selection). */
  moveCursor(delta: number): void {
    this.cursorLine = Math.max(
      0,
      Math.min(this.totalVisualLines - 1, this.cursorLine + delta),
    )
    this.ensureCursorVisible()
  }
  cursorToTop(): void {
    this.cursorLine = 0
    this.ensureCursorVisible()
  }
  cursorToBottom(): void {
    this.cursorLine = Math.max(0, this.totalVisualLines - 1)
    this.ensureCursorVisible()
  }

  private selRange(): readonly [number, number] {
    return this.anchorLine <= this.cursorLine
      ? [this.anchorLine, this.cursorLine]
      : [this.cursorLine, this.anchorLine]
  }
  selectionLineCount(): number {
    const [a, b] = this.selRange()
    return b - a + 1
  }
  /** The selected lines as plain text (ANSI stripped), for yanking. */
  selectionText(): string {
    const [a, b] = this.selRange()
    return this.flatLines
      .slice(a, b + 1)
      .map(stripAnsi)
      .join("\n")
  }

  /**
   * Window-relative row (0-based, within the visible viewport) of the VISUAL
   * cursor line, or -1 when not selecting / off-screen. The driver maps this
   * to a screen row so the terminal cursor visibly sits in the pane.
   */
  selectionCursorRow(): number {
    if (!this.selecting) return -1
    const row = this.cursorLine - this.topLine()
    return row >= 0 && row < this.viewportRows ? row : -1
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

  /** Flatten blocks into visual lines (memoized per block) + message starts. */
  private flatten(cols: number): {
    lines: string[]
    msgStarts: number[]
  } {
    const lines: string[] = []
    const msgStarts: number[] = []
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]!
      // A run of consecutive tool calls stays tightly grouped (no blank gap
      // between pills); blank lines separate everything else, so the reasoning
      // text reads as the spine and tools sit quietly under it.
      const prev = i > 0 ? this.blocks[i - 1] : undefined
      const tightWithPrev = prev?.kind === "tool" && block.kind === "tool"
      if (i > 0 && !tightWithPrev) lines.push("")
      if (block.kind === "user" || block.kind === "assistant") {
        msgStarts.push(lines.length)
      }
      lines.push(...this.blockLines(block, cols))
    }
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

  render(rows: number, cols: number): string[] {
    this.viewportRows = rows
    const { lines, msgStarts } = this.flatten(cols)
    this.flatLines = lines
    this.msgStartLines = msgStarts
    this.totalVisualLines = lines.length

    // Keep matches current if the buffer grew under an active query (streamed
    // lines, tool updates) — preserves the n/N cursor.
    if (this.searchQuery.length > 0) this.recomputeMatches()

    const [selLo, selHi] = this.selecting ? this.selRange() : [-1, -1]
    const decorate = (l: string, absIdx: number): string => {
      let s = this.searchQuery.length > 0 ? this.highlight(l) : l
      if (this.selecting && absIdx >= selLo && absIdx <= selHi) {
        // Line-wise selection: invert the whole row (drops other styling).
        s = `${ansi.inverse}${stripAnsi(s)}${ansi.reset}`
      }
      return padRight(truncate(s, cols), cols)
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

    // Independent above/below indicators (SCROLLING_REVIEW.md §A): hidden
    // content above shows at the top, hidden content below at the bottom.
    if (start > 0) {
      window[0] = `${ansi.dim}↑ ${start} more above${ansi.reset}`
    }
    if (this.scrollOffset > 0) {
      window[window.length - 1] =
        `${ansi.dim}${ansi.fgYellow}↓ ${this.scrollOffset} more below · PgDn to follow${ansi.reset}`
    }

    while (window.length < rows) window.push("")
    return window.map((l, i) => decorate(l, start + i))
  }
}
