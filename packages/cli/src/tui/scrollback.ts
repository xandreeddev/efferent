import { ansi, padRight, truncate, visibleLength } from "./terminal.js"
import { renderMarkdown } from "./markdown.js"

export type ToolPillState = "running" | "ok" | "error"

export type ScrollbackBlock =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly toolName: string
      readonly arg: string
      readonly state: ToolPillState
      readonly detail?: string
      /** Unified diff (edit_file/write_file) — rendered colorized below the pill. */
      readonly diff?: string
      /** Full textual output (bash/grep/read) — shown when expanded. */
      readonly output?: string
    }
  | { readonly kind: "info"; readonly text: string }
  | { readonly kind: "error"; readonly text: string }

const STATE_DOT: Record<ToolPillState, string> = {
  running: `${ansi.fgYellow}●${ansi.reset}`,
  ok: `${ansi.fgGreen}●${ansi.reset}`,
  error: `${ansi.fgRed}●${ansi.reset}`,
}

/**
 * Colorize a unified diff's *content* lines (green add / red remove). The
 * `--- / +++ / @@` headers are dropped — they're noise in the chat view;
 * the pill already names the file.
 */
const colorizeDiff = (diff: string): string[] =>
  diff
    .split("\n")
    .filter(
      (line) =>
        !line.startsWith("+++") &&
        !line.startsWith("---") &&
        !line.startsWith("@@"),
    )
    .map((line) => {
      if (line.startsWith("+")) return `${ansi.fgGreen}${line}${ansi.reset}`
      if (line.startsWith("-")) return `${ansi.fgRed}${line}${ansi.reset}`
      return `${ansi.dim}${line}${ansi.reset}`
    })

// Collapsed line caps; expanded shows up to the larger cap.
const DIFF_COLLAPSED = 8
const DIFF_EXPANDED = 200
const OUTPUT_EXPANDED = 120

const wrapText = (text: string, width: number): string[] => {
  const out: string[] = []
  for (const para of text.split("\n")) {
    if (para.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    for (const word of para.split(" ")) {
      if (line.length === 0) {
        line = word
        continue
      }
      if (visibleLength(line) + 1 + visibleLength(word) > width) {
        out.push(line)
        line = word
      } else {
        line += " " + word
      }
    }
    if (line.length > 0) out.push(line)
  }
  return out
}

const renderBlock = (
  block: ScrollbackBlock,
  cols: number,
  expanded: boolean,
): string[] => {
  switch (block.kind) {
    case "user": {
      const prefix = `${ansi.fgBrightGreen}>${ansi.reset} `
      const inner = wrapText(block.text, cols - 2)
      return inner.map((l, i) => (i === 0 ? prefix + l : "  " + l))
    }
    case "assistant": {
      return renderMarkdown(block.text)
    }
    case "tool": {
      const head = `${STATE_DOT[block.state]} ${ansi.bold}${block.toolName}${ansi.reset} ${ansi.fgGray}${truncate(block.arg, cols - 8)}${ansi.reset}`
      const indent = (l: string): string => `   ${truncate(l, cols - 4)}`

      // Diffs render colorized by default (collapsed); Ctrl-R reveals the rest.
      if (block.diff !== undefined && block.diff.length > 0) {
        const all = colorizeDiff(block.diff)
        const cap = expanded ? DIFF_EXPANDED : DIFF_COLLAPSED
        const shown = all.slice(0, cap).map(indent)
        if (all.length > cap) {
          shown.push(
            `   ${ansi.dim}… ${all.length - cap} more diff lines · Ctrl-R to expand${ansi.reset}`,
          )
        }
        return [head, ...shown]
      }

      // Full output (bash/grep/read) only when expanded; summary otherwise.
      if (expanded && block.output !== undefined && block.output.length > 0) {
        const lines = block.output.split("\n")
        const shown = lines
          .slice(0, OUTPUT_EXPANDED)
          .map((l) => `   ${ansi.dim}${truncate(l, cols - 4)}${ansi.reset}`)
        if (lines.length > OUTPUT_EXPANDED) {
          shown.push(
            `   ${ansi.dim}… ${lines.length - OUTPUT_EXPANDED} more lines${ansi.reset}`,
          )
        }
        return [head, ...shown]
      }

      if (block.detail !== undefined && block.detail.length > 0) {
        const detailLines = block.detail.split("\n").slice(0, 6).map(
          (l) => `   ${ansi.dim}${truncate(l, cols - 4)}${ansi.reset}`,
        )
        return [head, ...detailLines]
      }
      return [head]
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
      arg?: string
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
      ...(patch.arg !== undefined ? { arg: patch.arg } : {}),
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
      allLines.push(...renderBlock(block, cols, this.expanded))
      if (i < this.blocks.length - 1) {
        allLines.push("")
      }
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
