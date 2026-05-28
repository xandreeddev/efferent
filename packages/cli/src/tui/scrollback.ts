import { ansi, padLeft, padRight, truncate, wrapAnsi } from "./terminal.js"
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
 */
export class Scrollback {
  private blocks: ScrollbackBlock[] = []
  private toolIndex = new Map<string, number>()
  private scrollOffset = 0
  private lastTotalVisualLines = 0
  private expanded = false

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
    this.lastTotalVisualLines = 0
  }

  /** Shift the view by `delta` visual lines (positive = older content). */
  scrollBy(delta: number): void {
    const next = this.scrollOffset + delta
    this.scrollOffset = Math.max(0, next)
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
    return this.lastTotalVisualLines
  }

  render(rows: number, cols: number): string[] {
    const allLines: string[] = []
    for (let i = 0; i < this.blocks.length; i++) {
      const block = this.blocks[i]!
      // A run of consecutive tool calls stays tightly grouped (no blank
      // gap between pills); blank lines separate everything else, so the
      // reasoning text reads as the spine and tools sit quietly under it.
      const prev = i > 0 ? this.blocks[i - 1] : undefined
      const tightWithPrev = prev?.kind === "tool" && block.kind === "tool"
      if (i > 0 && !tightWithPrev) allLines.push("")
      allLines.push(...renderBlock(block, cols, this.expanded))
    }
    this.lastTotalVisualLines = allLines.length

    if (allLines.length <= rows) {
      this.scrollOffset = 0
      const window = allLines.slice()
      while (window.length < rows) window.push("")
      return window.map((l) => padRight(truncate(l, cols), cols))
    }

    const maxOffset = allLines.length - rows
    if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset
    const end = allLines.length - this.scrollOffset
    const start = Math.max(0, end - rows)
    const window = allLines.slice(start, end)

    if (this.scrollOffset > 0) {
      const indicator = `${ansi.dim}${ansi.fgYellow}↑ ${this.scrollOffset} more · PgDn to follow${ansi.reset}`
      window[0] = indicator
    } else if (start > 0) {
      const above = start
      window[0] = `${ansi.dim}↑ ${above} more above${ansi.reset}`
    }

    while (window.length < rows) window.push("")
    return window.map((l) => padRight(truncate(l, cols), cols))
  }
}
