import {
  ansi,
  beginSync,
  clearScreen,
  cursorBar,
  cursorBlock,
  endSync,
  getTermSize,
  hideCursor,
  home,
  moveTo,
  padRight,
  showCursor,
  visibleLength,
  write,
} from "./terminal.js"
import type { StatusState } from "./statusBar.js"
import { renderStatusBar } from "./statusBar.js"
import type { Scrollback } from "./scrollback.js"
import type { InputState } from "./input.js"
import { PROMPTS, renderInput } from "./input.js"
import type { PaletteState } from "./slashPalette.js"
import { renderPalette } from "./slashPalette.js"
import type { ModalState } from "./modal.js"
import { renderModal } from "./modal.js"
import type { SidePaneState } from "./sidePane.js"
import { renderSidePane, sideCursorRowAt } from "./sidePane.js"
import type { FocusPane, UiMode } from "./uiMode.js"
import type { EntryMode } from "./navKeys.js"
import { LEGEND_ROWS, renderLegend } from "./legend.js"

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
  /** Command-line mode of the input row: message / `:` command / `/` search. */
  readonly entry: EntryMode
  /** The focused read-only pane is maximized (fills the middle region). */
  readonly zoomed: boolean
}

/**
 * Overlay a right-aligned `i/total` search readout onto the input's first row,
 * preserving the line's ANSI (the coloured `/` prompt) up to the cut column.
 */
const withMatchCount = (
  line: string,
  info: { readonly index: number; readonly total: number },
  cols: number,
): string => {
  const count = info.total > 0 ? `${info.index}/${info.total}` : "no matches"
  const tag = ` ${ansi.dim}${count}${ansi.reset}`
  const cut = Math.max(0, cols - (count.length + 1))
  let visible = 0
  let out = ""
  const re = /\x1b\[[0-9;?]*[A-Za-z]|[\s\S]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    const tok = m[0]
    if (tok.startsWith("\x1b")) out += tok
    else if (visible < cut) {
      out += tok
      visible++
    }
  }
  if (visible < cut) out += " ".repeat(cut - visible)
  return out + ansi.reset + tag
}

const PALETTE_MAX_ROWS = 6
const MAX_INPUT_ROWS = 8
const SIDE_PANE_MIN_COLS = 60

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

    // The input prompt morphs with the entry mode: ❯ message · : command · / search.
    const inputResult = renderInput(
      state.input,
      cols,
      MAX_INPUT_ROWS,
      PROMPTS[state.entry],
    )
    const inputRows = Math.min(
      MAX_INPUT_ROWS,
      Math.max(1, inputResult.lines.length),
    )
    // Overlay above the input is the `:` command palette (when visible).
    const paletteRows = state.palette.visible
      ? Math.min(PALETTE_MAX_ROWS, state.palette.matches.length)
      : 0
    // Zoom applies only to a read-only pane; if focus drifted to the input,
    // treat it as un-zoomed (defensive — the driver clears it too).
    const zoomed =
      state.zoomed &&
      (state.focus === "conversation" || state.focus === "side")

    const convFocused = state.focus === "conversation"
    const sideFocused = state.focus === "side"
    const showSide = !zoomed && cols >= SIDE_PANE_MIN_COLS

    // Box content rows: total − top/bottom border − legend − palette − input − status.
    const contentRows = Math.max(
      0,
      rows - 2 - LEGEND_ROWS - paletteRows - inputRows - 1,
    )

    // --- bordered-box helpers (the focused box's border brightens) ---------
    const bcol = (focused: boolean): string =>
      focused ? ansi.fgBrightCyan : `${ansi.dim}${ansi.fgGray}`
    // A horizontal border with an embedded title, exactly `w` cells wide.
    const hseg = (rawLabel: string, w: number, focused: boolean): string => {
      const label = rawLabel.slice(0, Math.max(0, w - 3))
      const rest = Math.max(1, w - 2 - visibleLength(label))
      const c = bcol(focused)
      const title = focused
        ? `${ansi.bold}${ansi.fgBrightCyan}${label}${ansi.reset}`
        : `${ansi.dim}${label}${ansi.reset}`
      return `${c}─ ${ansi.reset}${title}${c} ${"─".repeat(rest - 1)}${ansi.reset}`
    }
    const vbar = (focused: boolean): string => `${bcol(focused)}│${ansi.reset}`
    const dashes = (n: number, focused: boolean): string =>
      `${bcol(focused)}${"─".repeat(Math.max(0, n))}${ansi.reset}`
    const corner = (ch: string, focused: boolean): string =>
      `${bcol(focused)}${ch}${ansi.reset}`

    // Content geometry inside the box(es).
    const convGutter = "  " // 2-col left margin; the block cursor sits on the cell
    const sideGutter = " "
    let leftInner: number
    let rightInner = 0
    let scrollW: number
    let sideW: number
    if (showSide) {
      const inner = Math.max(2, cols - 3) // left + middle + right borders
      rightInner = Math.min(Math.max(20, Math.floor(cols * 0.34)), inner - 12)
      leftInner = inner - rightInner
      scrollW = Math.max(1, leftInner - 2)
      sideW = Math.max(1, rightInner - 1)
    } else {
      leftInner = Math.max(1, cols - 2)
      scrollW = Math.max(1, leftInner - 2)
      sideW = Math.max(1, leftInner - 1)
    }
    const convContentW = scrollW
    const sideViewLabel = state.sidePane.view === "context" ? "context" : "side"

    const middleLines: string[] = []

    if (showSide) {
      const scrollLines = state.scrollback.render(contentRows, scrollW, convFocused)
      const sideLines = renderSidePane(
        state.sidePane,
        contentRows,
        sideW,
        state.spinnerFrame,
        sideFocused,
      )
      const midFocused = convFocused || sideFocused
      middleLines.push(
        corner("┌", convFocused) +
          hseg("conversation", leftInner, convFocused) +
          corner("┬", midFocused) +
          hseg(sideViewLabel, rightInner, sideFocused) +
          corner("┐", sideFocused),
      )
      for (let i = 0; i < contentRows; i++) {
        const left = padRight(convGutter + (scrollLines[i] ?? ""), leftInner)
        const right = padRight(sideGutter + (sideLines[i] ?? ""), rightInner)
        middleLines.push(
          vbar(convFocused) + left + vbar(midFocused) + right + vbar(sideFocused),
        )
      }
      middleLines.push(
        corner("└", convFocused) +
          dashes(leftInner, convFocused) +
          corner("┴", midFocused) +
          dashes(rightInner, sideFocused) +
          corner("┘", sideFocused),
      )
    } else {
      // A single box around the focused (or, when narrow, the only) pane.
      const sideBox = zoomed && sideFocused
      const f = zoomed ? true : convFocused
      const title = sideBox
        ? `${sideViewLabel} [zoom]`
        : zoomed
          ? "conversation [zoom]"
          : "conversation"
      const lines = sideBox
        ? renderSidePane(state.sidePane, contentRows, sideW, state.spinnerFrame, true)
        : state.scrollback.render(contentRows, scrollW, convFocused)
      const gutter = sideBox ? sideGutter : convGutter
      middleLines.push(corner("┌", f) + hseg(title, leftInner, f) + corner("┐", f))
      for (let i = 0; i < contentRows; i++) {
        middleLines.push(vbar(f) + padRight(gutter + (lines[i] ?? ""), leftInner) + vbar(f))
      }
      middleLines.push(corner("└", f) + dashes(leftInner, f) + corner("┘", f))
    }

    // Input region: pad to inputRows; overlay the search count on the first row.
    const inputLinesPadded: string[] = inputResult.lines.slice(0, inputRows)
    while (inputLinesPadded.length < inputRows) {
      inputLinesPadded.push(padRight("", cols))
    }
    if (state.entry === "search" && inputLinesPadded.length > 0) {
      inputLinesPadded[0] = withMatchCount(
        inputLinesPadded[0]!,
        state.scrollback.matchInfo(),
        cols,
      )
    }

    const legendLines = renderLegend(
      state.focus,
      state.mode,
      state.sidePane.view,
      state.entry,
      cols,
    )
    const overlayLines = renderPalette(state.palette, cols, PALETTE_MAX_ROWS)

    // Compose: box · always-on legend · palette? · input · status
    const frame: string[] = []
    for (const l of middleLines) frame.push(l)
    for (const l of legendLines) frame.push(l)
    for (const l of overlayLines) frame.push(l)
    for (const l of inputLinesPadded) frame.push(l)
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

    // The real cursor follows focus and mode:
    //  - input focused → a BAR in the input region (bottom) — covers the `:`/`/`
    //    command line too, since those are typed in the input;
    //  - conversation focused in NORMAL or VISUAL → a BLOCK on the cursor's
    //    actual (row, col) cell in the middle region — the nvim cursor;
    //  - otherwise hidden.
    if (
      !state.modal.visible &&
      state.focus === "input" &&
      !state.input.locked
    ) {
      // Input is the (inputRows)-tall region just above the status bar.
      const inputFirstRow = rows - inputRows // 1-based row of the input's first line
      const cursorRow = Math.min(inputResult.cursorRow, inputRows - 1)
      out +=
        moveTo(inputFirstRow + cursorRow, inputResult.cursorCol + 1) +
        cursorBar +
        showCursor
    } else if (
      !state.modal.visible &&
      state.focus === "conversation" &&
      (state.mode === "normal" || state.mode === "visual")
    ) {
      const row = state.scrollback.cursorRow()
      if (row >= 0) {
        // Box top border is screen row 1; content starts at row 2. Content
        // begins after the left border (col 1) + the 2-col gutter → screen col 4.
        const col = Math.min(
          state.scrollback.cursorVisibleCol(),
          Math.max(0, convContentW - 1),
        )
        out += moveTo(2 + row, 4 + col) + cursorBlock + showCursor
      } else {
        out += hideCursor
      }
    } else if (
      !state.modal.visible &&
      state.focus === "side" &&
      state.sidePane.view === "context" &&
      state.mode === "normal"
    ) {
      // The side context-tree cursor: a block on the focused row's first cell.
      const row = sideCursorRowAt(state.sidePane, contentRows)
      if (row >= 0) {
        // Side content starts after: left border + leftInner + mid border +
        // 1-col gutter (two boxes), or left border + 1-col gutter (zoomed).
        const startCol = showSide ? leftInner + 4 : 3
        out += moveTo(2 + row, startCol) + cursorBlock + showCursor
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
