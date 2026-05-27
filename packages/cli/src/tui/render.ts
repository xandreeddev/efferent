import {
  ansi,
  clearScreen,
  getTermSize,
  hideCursor,
  home,
  moveTo,
  padRight,
  showCursor,
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
import type { SidePaneState } from "./sidePane.js"
import { renderSidePane } from "./sidePane.js"

export interface AppState {
  readonly status: StatusState
  readonly scrollback: Scrollback
  readonly input: InputState
  readonly palette: PaletteState
  readonly modal: ModalState
  readonly sidePane: SidePaneState
}

const PALETTE_MAX_ROWS = 6
const MAX_INPUT_ROWS = 8
const SIDE_PANE_MIN_COLS = 60

const DIVIDER = `${ansi.fgGray}│${ansi.reset}`

/** Right-pane width: ~36% of the terminal, hidden under SIDE_PANE_MIN_COLS. */
const computeSidePaneWidth = (cols: number): number => {
  if (cols < SIDE_PANE_MIN_COLS) return 0
  return Math.max(24, Math.floor(cols * 0.36))
}

const hRule = (cols: number): string =>
  `${ansi.fgGray}${"─".repeat(cols)}${ansi.reset}`

/**
 * Render the whole TUI as one frame. Diffs against the previous frame
 * line-by-line and writes only the changes — minimises flicker without
 * needing libuv tricks.
 *
 * Layout (top → bottom):
 *   middle = scrollback | side pane
 *   ── separator ──
 *   palette? (overlay row group)
 *   input (1–MAX_INPUT_ROWS rows, wrapped visually)
 *   ── separator ──
 *   status bar (1 row)
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

    const inputResult = renderInput(state.input, cols)
    const inputRows = Math.min(
      MAX_INPUT_ROWS,
      Math.max(1, inputResult.lines.length),
    )
    const paletteRows = state.palette.visible
      ? Math.min(PALETTE_MAX_ROWS, state.palette.matches.length)
      : 0
    const middleRows = Math.max(
      0,
      rows - 1 /* status */ - 1 /* status sep */ - inputRows - 1 /* input sep */ - paletteRows,
    )

    const sidePaneWidth = computeSidePaneWidth(cols)
    const dividerWidth = sidePaneWidth > 0 ? 1 : 0
    const leftWidth = Math.max(10, cols - sidePaneWidth - dividerWidth)

    // Middle: scrollback | side pane
    const scrollLines = state.scrollback.render(middleRows, leftWidth)
    const sideLines = renderSidePane(state.sidePane, middleRows, sidePaneWidth)
    const middleLines: string[] = []
    for (let i = 0; i < middleRows; i++) {
      const left = scrollLines[i] ?? padRight("", leftWidth)
      if (sidePaneWidth > 0) {
        const right = sideLines[i] ?? padRight("", sidePaneWidth)
        middleLines.push(left + DIVIDER + right)
      } else {
        middleLines.push(left)
      }
    }

    // Input region: pad the visual rows to inputRows
    const inputLinesPadded: string[] = inputResult.lines.slice(0, inputRows)
    while (inputLinesPadded.length < inputRows) {
      inputLinesPadded.push(padRight("", cols))
    }

    // Palette overlay just above input
    const paletteLines = renderPalette(state.palette, cols, PALETTE_MAX_ROWS)

    // Compose
    const frame: string[] = []
    for (const l of middleLines) frame.push(l)
    frame.push(hRule(cols))
    for (const l of paletteLines) frame.push(l)
    for (const l of inputLinesPadded) frame.push(l)
    frame.push(hRule(cols))
    frame.push(renderStatusBar(state.status, cols))
    while (frame.length < rows) frame.push(padRight("", cols))
    frame.length = rows

    // Diff against previous frame
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
      if (ov.row - 1 >= 0 && ov.row - 1 < this.prev.length) {
        this.prev[ov.row - 1] = ""
      }
    }

    // Cursor: inside the input region. From the bottom up, the last
    // three rows are: status (1) | separator (1) | input (inputRows).
    // So the first input row's 1-indexed screen position is
    // `rows - inputRows - 1`, and visual cursor row 0 maps to it.
    if (!state.modal.visible && !state.input.locked) {
      const inputStartRow = rows - inputRows - 1
      const cursorRow = Math.min(inputResult.cursorRow, inputRows - 1)
      out +=
        moveTo(inputStartRow + cursorRow, inputResult.cursorCol + 1) +
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
