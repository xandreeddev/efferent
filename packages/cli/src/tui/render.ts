import {
  ansi,
  beginSync,
  clearScreen,
  endSync,
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
import type { SidePaneState } from "./sidePane.js"
import { renderSidePane } from "./sidePane.js"
import type { FocusPane, UiMode } from "./uiMode.js"
import { renderHeader } from "./header.js"

export interface AppState {
  readonly status: StatusState
  readonly scrollback: Scrollback
  readonly input: InputState
  readonly palette: PaletteState
  readonly modal: ModalState
  readonly sidePane: SidePaneState
  /** Spinner animation frame, for the side-pane tree's running nodes. */
  readonly spinnerFrame: number
  /** Which pane has focus (drives the hint bar + focused-pane highlight). */
  readonly focus: FocusPane
  /** Current modal mode (drives the hint bar + status). */
  readonly mode: UiMode
  /** Active `/` search query — when set, a search bar replaces the palette. */
  readonly search?: { readonly query: string } | undefined
}

/** vim-style `/` search bar: `/query` on the left, `i/total` on the right. */
const renderSearchBar = (
  query: string,
  info: { readonly index: number; readonly total: number },
  cols: number,
): string => {
  const left = `${ansi.fgYellow}/${ansi.reset}${query}`
  const count = info.total > 0 ? `${info.index}/${info.total}` : "no matches"
  const right = `${ansi.dim}${count}${ansi.reset}`
  const gap = Math.max(1, cols - visibleLength(left) - count.length - 1)
  return padRight(truncate(`${left}${" ".repeat(gap)}${right}`, cols), cols)
}

const PALETTE_MAX_ROWS = 6
const MAX_INPUT_ROWS = 8
const SIDE_PANE_MIN_COLS = 60
const HEADER_ROWS = 1

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
    let sizeChangePrefix = ""
    if (rows !== this.prevSize.rows || cols !== this.prevSize.cols) {
      this.prev = []
      this.prevSize = { rows, cols }
      sizeChangePrefix = clearScreen + home
    }

    const inputResult = renderInput(state.input, cols)
    const inputRows = Math.min(
      MAX_INPUT_ROWS,
      Math.max(1, inputResult.lines.length),
    )
    // The overlay row group above the input is either the `/` search bar
    // (1 row) or the `:` command palette — they never show together.
    const paletteRows = state.palette.visible
      ? Math.min(PALETTE_MAX_ROWS, state.palette.matches.length)
      : 0
    const overlayRows = state.search !== undefined ? 1 : paletteRows
    const middleRows = Math.max(
      0,
      rows -
        HEADER_ROWS /* top hint bar */ -
        1 /* status */ -
        1 /* status sep */ -
        inputRows -
        1 /* input sep */ -
        overlayRows,
    )

    const sidePaneWidth = computeSidePaneWidth(cols)
    const dividerWidth = sidePaneWidth > 0 ? 1 : 0
    const leftWidth = Math.max(10, cols - sidePaneWidth - dividerWidth)

    // Each middle pane reserves a 1-col focus gutter (constant width, so
    // switching focus never reflows text). The gutter is a bright bar on the
    // focused pane, blank otherwise — the in-content "active pane" signal.
    const FOCUS_BAR = `${ansi.bold}${ansi.fgBrightCyan}▌${ansi.reset}`
    const convGutter = state.focus === "conversation" ? FOCUS_BAR : " "
    const sideGutter = state.focus === "side" ? FOCUS_BAR : " "
    const scrollW = Math.max(1, leftWidth - 1)
    const sideW = sidePaneWidth > 0 ? Math.max(1, sidePaneWidth - 1) : 0

    const scrollLines = state.scrollback.render(middleRows, scrollW)
    const sideLines = renderSidePane(
      state.sidePane,
      middleRows,
      sideW,
      state.spinnerFrame,
    )
    const divider =
      state.focus === "side"
        ? `${ansi.bold}${ansi.fgBrightCyan}│${ansi.reset}`
        : DIVIDER
    const middleLines: string[] = []
    for (let i = 0; i < middleRows; i++) {
      const left = convGutter + (scrollLines[i] ?? padRight("", scrollW))
      if (sidePaneWidth > 0) {
        const right = sideGutter + (sideLines[i] ?? padRight("", sideW))
        middleLines.push(left + divider + right)
      } else {
        middleLines.push(left)
      }
    }

    // Input region: pad the visual rows to inputRows
    const inputLinesPadded: string[] = inputResult.lines.slice(0, inputRows)
    while (inputLinesPadded.length < inputRows) {
      inputLinesPadded.push(padRight("", cols))
    }

    // Overlay just above input: search bar (if active) else the palette.
    const overlayLines =
      state.search !== undefined
        ? [renderSearchBar(state.search.query, state.scrollback.matchInfo(), cols)]
        : renderPalette(state.palette, cols, PALETTE_MAX_ROWS)

    // Compose
    const frame: string[] = []
    frame.push(
      renderHeader(state.mode, state.focus, state.search !== undefined, cols),
    )
    for (const l of middleLines) frame.push(l)
    frame.push(hRule(cols))
    for (const l of overlayLines) frame.push(l)
    for (const l of inputLinesPadded) frame.push(l)
    frame.push(hRule(cols))
    frame.push(renderStatusBar(state.status, cols))
    while (frame.length < rows) frame.push(padRight("", cols))
    frame.length = rows

    // Diff against previous frame
    let out = sizeChangePrefix + hideCursor
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

    // Cursor follows focus, so a pane swap is visible:
    //  - searching → in the search bar;
    //  - input focused → in the input region (bottom);
    //  - conversation + VISUAL → on the selected line in the middle region;
    //  - otherwise hidden (read-only panes have no insertion cursor — focus is
    //    shown by the badge + gutter, and the input box no longer "holds" it).
    if (state.search !== undefined && !state.modal.visible) {
      const barRow = rows - inputRows - 1 - 1
      out += moveTo(barRow, 2 + state.search.query.length) + showCursor
    } else if (
      !state.modal.visible &&
      state.focus === "input" &&
      !state.input.locked
    ) {
      const inputStartRow = rows - inputRows - 1
      const cursorRow = Math.min(inputResult.cursorRow, inputRows - 1)
      out +=
        moveTo(inputStartRow + cursorRow, inputResult.cursorCol + 1) +
        showCursor
    } else if (
      !state.modal.visible &&
      state.focus === "conversation" &&
      state.mode === "visual"
    ) {
      const row = state.scrollback.selectionCursorRow()
      if (row >= 0) {
        // Middle region starts just below the header; content starts after the
        // 1-col focus gutter.
        out += moveTo(HEADER_ROWS + 1 + row, 2) + showCursor
      } else {
        out += hideCursor
      }
    } else {
      out += hideCursor
    }

    write(beginSync + out + endSync)
  }

  reset(): void {
    this.prev = []
    this.prevSize = { rows: 0, cols: 0 }
  }
}
