import {
  ansi,
  clearScreen,
  getTermSize,
  hideCursor,
  home,
  moveTo,
  padRight,
  showCursor,
  truncate,
  visibleLength,
  write,
} from "./terminal.js"
import type { StatusState } from "./statusBar.js"
import { renderStatusBar } from "./statusBar.js"
import type { Scrollback } from "./scrollback.js"
import type { InputState } from "./input.js"
import { renderInput } from "./input.js"
import type { PaletteState } from "./slashPalette.js"
import { renderPalette } from "./slashPalette.js"
import type { ModalState } from "./modal.js"
import { renderModal } from "./modal.js"
import type { LogBuffer } from "./logBuffer.js"

export interface AppState {
  readonly status: StatusState
  readonly scrollback: Scrollback
  readonly input: InputState
  readonly palette: PaletteState
  readonly modal: ModalState
  /** Optional live log feed shown in the right pane. */
  readonly logBuffer?: LogBuffer
}

const PALETTE_MAX_ROWS = 6
const DIVIDER = `${ansi.fgGray}│${ansi.reset}`
const RIGHT_HEADER = (cols: number): string =>
  `${ansi.bold}${ansi.fgGray}logs${ansi.reset}` +
  (cols > 30
    ? ` ${ansi.dim}(tail -f ~/.agent/agent.log)${ansi.reset}`
    : "")

/** Reserve at least 30 cols for the right pane, but never more than 40% of width. */
const computeLogPaneWidth = (cols: number): number => {
  if (cols < 100) return Math.max(0, Math.min(30, Math.floor(cols * 0.35)))
  return Math.min(50, Math.max(36, Math.floor(cols * 0.4)))
}

/**
 * Render log lines for the right pane. Wraps long lines by truncating
 * (we want to see the latest tail, not full history). Returns exactly
 * `rows` lines, padded right.
 */
const renderLogPane = (
  buffer: LogBuffer | undefined,
  rows: number,
  cols: number,
): string[] => {
  if (buffer === undefined || rows <= 0 || cols <= 0) {
    return Array.from({ length: Math.max(0, rows) }, () => "")
  }
  const out: string[] = []
  // Header (1 row): "logs (tail -f ...)"
  out.push(padRight(truncate(RIGHT_HEADER(cols), cols), cols))
  // Separator (1 row)
  out.push(`${ansi.fgGray}${"─".repeat(cols)}${ansi.reset}`)
  const remaining = rows - out.length
  if (remaining <= 0) return out.slice(0, rows)
  const recent = buffer.tail(remaining)
  for (const line of recent) {
    out.push(`${ansi.dim}${padRight(truncate(line, cols), cols)}${ansi.reset}`)
  }
  while (out.length < rows) out.push(padRight("", cols))
  return out.slice(0, rows)
}

/**
 * Render the whole TUI as one frame. Diffs against the previous frame
 * line-by-line and writes only the changes — minimises flicker without
 * needing libuv tricks.
 */
export class FrameRenderer {
  private prev: string[] = []
  private prevSize = { rows: 0, cols: 0 }

  draw(state: AppState): void {
    const { rows, cols } = getTermSize()
    if (rows !== this.prevSize.rows || cols !== this.prevSize.cols) {
      this.prev = []
      this.prevSize = { rows, cols }
      write(clearScreen + home)
    }

    const inputLines = state.input.lines.length || 1
    const lockedLine = state.input.locked ? 1 : 0
    const paletteRows = state.palette.visible
      ? Math.min(PALETTE_MAX_ROWS, state.palette.matches.length)
      : 0
    const inputRegionHeight = Math.max(1, inputLines) + lockedLine
    const middleRows = Math.max(
      0,
      rows - 1 /* status */ - paletteRows - inputRegionHeight,
    )

    const logPaneWidth = state.logBuffer !== undefined ? computeLogPaneWidth(cols) : 0
    const dividerWidth = logPaneWidth > 0 ? 1 : 0
    const leftWidth = Math.max(10, cols - logPaneWidth - dividerWidth)

    // 1) Status (row 1, full width)
    const statusLine = renderStatusBar(state.status, cols)

    // 2) Middle: scrollback (left) | divider | log feed (right)
    const scrollLines = state.scrollback.render(middleRows, leftWidth)
    const logLines = renderLogPane(state.logBuffer, middleRows, logPaneWidth)
    const middleLines: string[] = []
    for (let i = 0; i < middleRows; i++) {
      const left = scrollLines[i] ?? padRight("", leftWidth)
      if (logPaneWidth > 0) {
        const right = logLines[i] ?? padRight("", logPaneWidth)
        middleLines.push(left + DIVIDER + right)
      } else {
        middleLines.push(left)
      }
    }

    // 3) Palette (just above input, full width)
    const paletteLines = renderPalette(state.palette, cols, PALETTE_MAX_ROWS)

    // 4) Input region (last `inputRegionHeight` rows, full width)
    const inputResult = renderInput(state.input, cols)
    const inputLinesPadded: string[] = inputResult.lines.slice(0)
    while (inputLinesPadded.length < inputRegionHeight) {
      inputLinesPadded.push(padRight("", cols))
    }

    const frame: string[] = []
    frame.push(statusLine)
    for (const l of middleLines) frame.push(l)
    for (const l of paletteLines) frame.push(l)
    for (const l of inputLinesPadded) frame.push(l)
    while (frame.length < rows) frame.push(padRight("", cols))
    frame.length = rows

    // Diff
    let out = hideCursor
    for (let r = 0; r < rows; r++) {
      if (this.prev[r] !== frame[r]) {
        out += moveTo(r + 1, 1) + ansi.reset + (frame[r] ?? "")
        this.prev[r] = frame[r] ?? ""
      }
    }

    // Modal overlay
    const overlay = renderModal(state.modal, rows, cols)
    for (const ov of overlay) {
      out += moveTo(ov.row, ov.col) + ov.content
      // Force redraw of any line we painted over.
      if (ov.row - 1 >= 0 && ov.row - 1 < this.prev.length) {
        this.prev[ov.row - 1] = ""
      }
    }

    // Cursor position: in input region; only if no modal and not locked.
    if (!state.modal.visible && !state.input.locked) {
      const inputStartRow = rows - inputRegionHeight + 1
      out +=
        moveTo(inputStartRow + inputResult.cursorRow, inputResult.cursorCol + 1) +
        showCursor
    } else {
      out += hideCursor
    }

    write(out)
  }

  reset(): void {
    this.prev = []
    this.prevSize = { rows: 0, cols: 0 }
  }
}

// `visibleLength` is exported here to keep the public surface stable.
export { visibleLength }
