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

export interface AppState {
  readonly status: StatusState
  readonly scrollback: Scrollback
  readonly input: InputState
  readonly palette: PaletteState
  readonly modal: ModalState
}

const PALETTE_MAX_ROWS = 6

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
    const scrollRows = Math.max(
      0,
      rows - 1 /* status */ - paletteRows - inputRegionHeight,
    )

    // 1) Status (row 1)
    const statusLine = renderStatusBar(state.status, cols)

    // 2) Scrollback (rows 2 .. 2 + scrollRows - 1)
    const scrollLines = state.scrollback.render(scrollRows, cols)

    // 3) Palette (just above input)
    const paletteLines = renderPalette(state.palette, cols, PALETTE_MAX_ROWS)

    // 4) Input region (last `inputRegionHeight` rows)
    const inputResult = renderInput(state.input, cols)
    const inputLinesPadded: string[] = inputResult.lines.slice(0)
    while (inputLinesPadded.length < inputRegionHeight) {
      inputLinesPadded.push(padRight("", cols))
    }

    const frame: string[] = []
    frame.push(statusLine)
    for (const l of scrollLines) frame.push(l)
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
