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
import { renderSidePane } from "./sidePane.js"
import type { FocusPane, UiMode } from "./uiMode.js"
import type { EntryMode } from "./navKeys.js"
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
    const middleRows = Math.max(
      0,
      rows -
        HEADER_ROWS /* top hint bar */ -
        1 /* status */ -
        1 /* status sep */ -
        inputRows -
        1 /* input sep */ -
        paletteRows,
    )

    // Zoom only ever applies to a read-only pane; if focus drifted to the
    // input, treat it as un-zoomed (defensive — the driver clears it too).
    const zoomed =
      state.zoomed &&
      (state.focus === "conversation" || state.focus === "side")

    // Each middle pane reserves a 1-col gutter (constant width, so switching
    // focus never reflows text). Neither pane draws a focus bar — a bar flush
    // against the content reads as overlapping it; focus is shown by the
    // highlighted pane title + the bright divider + the badge (+ the cursor
    // caret/tint on the conversation).
    // The conversation cursor caret — bright yellow so it stands apart from the
    // cyan ●/┃ content bullets; dim when unfocused (a `/` search shows where
    // Enter will land you).
    const CARET = `${ansi.bold}${ansi.fgBrightYellow}▶${ansi.reset}`
    const CARET_DIM = `${ansi.dim}▶${ansi.reset}`

    const paneTitle = (label: string, focused: boolean, width: number): string => {
      const styled = focused
        ? `${ansi.bold}${ansi.fgBrightCyan}${label}${ansi.reset}`
        : `${ansi.dim}${label}${ansi.reset}`
      return padRight(truncate(styled, width), width)
    }

    // A pinned title row identifies the panes (focused one highlighted); the
    // scrollback/side get the remaining rows.
    const hasTitle = middleRows > 0
    const contentRows = Math.max(0, middleRows - (hasTitle ? 1 : 0))

    const convFocused = state.focus === "conversation"
    // Window-relative cursor row — read *after* scrollback.render() below, so
    // it reflects the freshly-flattened viewport (not a stale snapshot).
    let cursorRowConv = -1
    // Conversation gutter (2 cols): a caret + space on the cursor line, else two
    // blanks. The trailing space keeps the caret from abutting the content (so
    // a line like `29. …` reads `▶ 29. …`, not `▶29. …`) and gives every row a
    // small left margin.
    const convGutterAt = (i: number): string =>
      i === cursorRowConv ? (convFocused ? `${CARET} ` : `${CARET_DIM} `) : "  "

    const middleLines: string[] = []

    if (zoomed) {
      // One pane fills the whole middle width.
      if (state.focus === "side") {
        const contentW = Math.max(1, cols - 1) // 1-col gutter
        const sideLines = renderSidePane(
          state.sidePane,
          contentRows,
          contentW,
          state.spinnerFrame,
        )
        if (hasTitle) {
          middleLines.push(" " + paneTitle(" context [zoom]", true, contentW))
        }
        for (let i = 0; i < contentRows; i++) {
          middleLines.push(" " + (sideLines[i] ?? padRight("", contentW)))
        }
      } else {
        const contentW = Math.max(1, cols - 2) // 2-col caret gutter
        const scrollLines = state.scrollback.render(contentRows, contentW, true)
        cursorRowConv = state.scrollback.cursorRow()
        if (hasTitle) {
          middleLines.push("  " + paneTitle(" conversation [zoom]", true, contentW))
        }
        for (let i = 0; i < contentRows; i++) {
          middleLines.push(convGutterAt(i) + (scrollLines[i] ?? padRight("", contentW)))
        }
      }
    } else {
      const sidePaneWidth = computeSidePaneWidth(cols)
      const dividerWidth = sidePaneWidth > 0 ? 1 : 0
      const leftWidth = Math.max(10, cols - sidePaneWidth - dividerWidth)
      const scrollW = Math.max(1, leftWidth - 2) // 2-col caret gutter
      const sideW = sidePaneWidth > 0 ? Math.max(1, sidePaneWidth - 1) : 0
      // No focus bars: the conversation gutter is the 2-col caret gutter, the
      // side gutter a single space. Focus shown by the highlighted title +
      // divider + badge (+ caret/tint on the conversation).
      const convTitleGutter = "  "
      const sideGutter = " "
      const divider =
        state.focus === "side"
          ? `${ansi.bold}${ansi.fgBrightCyan}│${ansi.reset}`
          : DIVIDER

      const scrollLines = state.scrollback.render(contentRows, scrollW, convFocused)
      cursorRowConv = state.scrollback.cursorRow()
      const sideLines = renderSidePane(
        state.sidePane,
        contentRows,
        sideW,
        state.spinnerFrame,
      )

      if (hasTitle) {
        const leftTitle =
          convTitleGutter + paneTitle(" conversation", convFocused, scrollW)
        middleLines.push(
          sidePaneWidth > 0
            ? leftTitle +
                divider +
                sideGutter +
                paneTitle(" context", state.focus === "side", sideW)
            : leftTitle,
        )
      }
      for (let i = 0; i < contentRows; i++) {
        const left = convGutterAt(i) + (scrollLines[i] ?? padRight("", scrollW))
        if (sidePaneWidth > 0) {
          const right = sideGutter + (sideLines[i] ?? padRight("", sideW))
          middleLines.push(left + divider + right)
        } else {
          middleLines.push(left)
        }
      }
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

    const overlayLines = renderPalette(state.palette, cols, PALETTE_MAX_ROWS)

    // Compose
    const frame: string[] = []
    frame.push(renderHeader(state.mode, state.focus, state.entry, state.zoomed, cols))
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
    //  - input focused → in the input region (bottom) — covers the `:`/`/`
    //    command line too, since those are typed in the input;
    //  - conversation + VISUAL → on the selected line in the middle region;
    //  - otherwise hidden (read-only panes have no insertion cursor — focus is
    //    shown by the badge + gutter + pane title).
    if (
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
      const row = state.scrollback.cursorRow()
      if (row >= 0) {
        // Content rows start below the header + the pinned title row, after the
        // 2-col conversation gutter (so the cursor sits on the content, col 3).
        out += moveTo(HEADER_ROWS + 2 + row, 3) + showCursor
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
