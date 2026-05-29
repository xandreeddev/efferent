import { ansi, padRight } from "./terminal.js"
import type { Key } from "./keys.js"

export interface InputState {
  /** Logical lines of the current input (newlines via Ctrl-J or paste). */
  readonly lines: ReadonlyArray<string>
  /** Cursor position in logical coordinates. */
  readonly row: number
  readonly col: number
  /** Locked while a turn is in flight — keys are ignored except Ctrl-C. */
  readonly locked: boolean
}

export const emptyInput: InputState = {
  lines: [""],
  row: 0,
  col: 0,
  locked: false,
}

export const inputText = (s: InputState): string => s.lines.join("\n")

export const isEmpty = (s: InputState): boolean =>
  s.lines.length === 1 && s.lines[0]!.length === 0

export type InputAction =
  | { readonly type: "submit"; readonly text: string }
  | { readonly type: "exit" }
  | { readonly type: "clearScrollback" }

export interface InputUpdate {
  readonly state: InputState
  readonly action?: InputAction
}

const PROMPT = "❯ "
const CONT = "  "
const PREFIX_WIDTH = 2

/**
 * The input line is a vim-style command line: its prompt reflects what's being
 * entered — a message (`❯`), a `:` command, or a `/` search. Every `plain`
 * prompt is exactly PREFIX_WIDTH columns so the wrap/cursor math is identical.
 */
export interface PromptStyle {
  readonly plain: string
  readonly colored: string
}
export const PROMPTS = {
  message: { plain: PROMPT, colored: `${ansi.fgBrightGreen}❯${ansi.reset} ` },
  command: { plain: ": ", colored: `${ansi.fgBrightCyan}:${ansi.reset} ` },
  search: { plain: "/ ", colored: `${ansi.fgBrightYellow}/${ansi.reset} ` },
} as const satisfies Record<string, PromptStyle>

/** Per-logical-line wrap: visible chars per visual row, sliced at spaces when possible. */
const wrapLine = (text: string, contentWidth: number): string[] => {
  if (contentWidth <= 0) return [text]
  if (text.length <= contentWidth) return [text]
  const out: string[] = []
  let rest = text
  while (rest.length > contentWidth) {
    let breakAt = rest.lastIndexOf(" ", contentWidth)
    if (breakAt <= 0) breakAt = contentWidth
    out.push(rest.slice(0, breakAt))
    rest = rest.slice(breakAt === contentWidth ? breakAt : breakAt + 1)
  }
  if (rest.length > 0) out.push(rest)
  return out
}

/** Visual chunks per logical line, plus cumulative starts so we can map cursor. */
interface LineLayout {
  /** Visual chunks for the logical line (text only, prefix not included). */
  readonly chunks: ReadonlyArray<string>
  /** Char offset within the logical line at which each chunk starts. */
  readonly chunkStarts: ReadonlyArray<number>
  /** Index into the global visualLines array of the first chunk. */
  readonly visualStartRow: number
}

interface InputLayout {
  readonly visualLines: ReadonlyArray<string>
  readonly lineLayouts: ReadonlyArray<LineLayout>
  readonly cursorVisualRow: number
  readonly cursorVisualCol: number
}

export const layoutInput = (
  state: InputState,
  cols: number,
  prompt: PromptStyle = PROMPTS.message,
): InputLayout => {
  const contentWidth = Math.max(1, cols - PREFIX_WIDTH)
  const visualLines: string[] = []
  const lineLayouts: LineLayout[] = []

  for (let row = 0; row < state.lines.length; row++) {
    const text = state.lines[row] ?? ""
    const chunks = wrapLine(text, contentWidth)
    const chunkStarts: number[] = []
    let cursor = 0
    for (let i = 0; i < chunks.length; i++) {
      chunkStarts.push(cursor)
      cursor += chunks[i]!.length
      // If we broke at a space, the broken character is consumed (not shown
      // at the start of the next chunk) — bump the next start by 1.
      if (i < chunks.length - 1 && text[cursor] === " ") cursor += 1
    }
    const visualStartRow = visualLines.length
    for (let i = 0; i < chunks.length; i++) {
      const prefix = row === 0 && i === 0 ? prompt.plain : CONT
      visualLines.push(prefix + chunks[i]!)
    }
    lineLayouts.push({
      chunks,
      chunkStarts,
      visualStartRow,
    })
  }

  const layout = lineLayouts[state.row] ?? lineLayouts[0]!
  const { chunks, chunkStarts, visualStartRow } = layout

  // Find which chunk contains state.col.
  let chunkIdx = 0
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (state.col >= chunkStarts[i]!) {
      chunkIdx = i
      break
    }
  }
  const offsetInChunk = state.col - (chunkStarts[chunkIdx] ?? 0)
  const cursorVisualRow = visualStartRow + chunkIdx
  const cursorVisualCol =
    PREFIX_WIDTH + Math.min(offsetInChunk, (chunks[chunkIdx] ?? "").length)

  return {
    visualLines,
    lineLayouts,
    cursorVisualRow,
    cursorVisualCol,
  }
}

const positionAtVisualRow = (
  state: InputState,
  cols: number,
  visualRow: number,
): { row: number; col: number } | undefined => {
  const layout = layoutInput(state, cols)
  if (visualRow < 0 || visualRow >= layout.visualLines.length) return undefined
  for (let r = 0; r < layout.lineLayouts.length; r++) {
    const ll = layout.lineLayouts[r]!
    if (
      visualRow >= ll.visualStartRow &&
      visualRow < ll.visualStartRow + ll.chunks.length
    ) {
      const chunkIdx = visualRow - ll.visualStartRow
      const baseCol = ll.chunkStarts[chunkIdx] ?? 0
      const targetVisualCol = Math.max(
        PREFIX_WIDTH,
        layout.cursorVisualCol,
      )
      const within = Math.max(0, targetVisualCol - PREFIX_WIDTH)
      const chunkLen = (ll.chunks[chunkIdx] ?? "").length
      return { row: r, col: baseCol + Math.min(within, chunkLen) }
    }
  }
  return undefined
}

export const applyKey = (
  state: InputState,
  key: Key,
  cols: number,
): InputUpdate => {
  if (state.locked) {
    if (key.type === "ctrl" && key.char === "c") {
      return { state, action: { type: "exit" } }
    }
    return { state }
  }
  switch (key.type) {
    case "char": {
      const lines = state.lines.slice()
      const cur = lines[state.row] ?? ""
      lines[state.row] = cur.slice(0, state.col) + key.char + cur.slice(state.col)
      return {
        state: { ...state, lines, col: state.col + key.char.length },
      }
    }
    case "paste": {
      const incoming = key.text.split("\n")
      const lines = state.lines.slice()
      const cur = lines[state.row] ?? ""
      const before = cur.slice(0, state.col)
      const after = cur.slice(state.col)
      if (incoming.length === 1) {
        lines[state.row] = before + incoming[0]! + after
        return {
          state: {
            ...state,
            lines,
            col: state.col + incoming[0]!.length,
          },
        }
      }
      const first = incoming[0]!
      const last = incoming[incoming.length - 1]!
      const middle = incoming.slice(1, -1)
      lines.splice(state.row, 1, before + first, ...middle, last + after)
      return {
        state: {
          ...state,
          lines,
          row: state.row + incoming.length - 1,
          col: last.length,
        },
      }
    }
    case "backspace": {
      if (state.col === 0 && state.row === 0) return { state }
      const lines = state.lines.slice()
      if (state.col === 0) {
        const prev = lines[state.row - 1] ?? ""
        const cur = lines[state.row] ?? ""
        lines.splice(state.row - 1, 2, prev + cur)
        return {
          state: { ...state, lines, row: state.row - 1, col: prev.length },
        }
      }
      const cur = lines[state.row] ?? ""
      lines[state.row] = cur.slice(0, state.col - 1) + cur.slice(state.col)
      return { state: { ...state, lines, col: state.col - 1 } }
    }
    case "enter": {
      const text = inputText(state)
      if (text.trim().length === 0) return { state }
      return {
        state: emptyInput,
        action: { type: "submit", text },
      }
    }
    case "ctrl": {
      switch (key.char) {
        case "c":
          return { state, action: { type: "exit" } }
        case "h":
          // Ctrl-H (0x08) as an alternate Backspace, for terminals/keymaps
          // that send 0x08 for the Backspace key while editing.
          return applyKey(state, { type: "backspace" }, cols)
        case "d":
          if (isEmpty(state)) return { state, action: { type: "exit" } }
          return { state }
        case "l":
          return { state, action: { type: "clearScrollback" } }
        case "j": {
          const lines = state.lines.slice()
          const cur = lines[state.row] ?? ""
          const before = cur.slice(0, state.col)
          const after = cur.slice(state.col)
          lines.splice(state.row, 1, before, after)
          return {
            state: { ...state, lines, row: state.row + 1, col: 0 },
          }
        }
        case "a":
          return { state: { ...state, col: 0 } }
        case "e":
          return {
            state: { ...state, col: (state.lines[state.row] ?? "").length },
          }
        case "u": {
          const lines = state.lines.slice()
          const cur = lines[state.row] ?? ""
          lines[state.row] = cur.slice(state.col)
          return { state: { ...state, lines, col: 0 } }
        }
        case "k": {
          const lines = state.lines.slice()
          const cur = lines[state.row] ?? ""
          lines[state.row] = cur.slice(0, state.col)
          return { state: { ...state, lines } }
        }
        case "w": {
          const lines = state.lines.slice()
          const cur = lines[state.row] ?? ""
          let i = state.col
          while (i > 0 && cur[i - 1] === " ") i--
          while (i > 0 && cur[i - 1] !== " ") i--
          lines[state.row] = cur.slice(0, i) + cur.slice(state.col)
          return { state: { ...state, lines, col: i } }
        }
      }
      return { state }
    }
    case "arrow": {
      switch (key.dir) {
        case "left":
          if (state.col > 0) return { state: { ...state, col: state.col - 1 } }
          if (state.row > 0) {
            const prev = state.lines[state.row - 1] ?? ""
            return { state: { ...state, row: state.row - 1, col: prev.length } }
          }
          return { state }
        case "right": {
          const cur = state.lines[state.row] ?? ""
          if (state.col < cur.length) return { state: { ...state, col: state.col + 1 } }
          if (state.row < state.lines.length - 1) {
            return { state: { ...state, row: state.row + 1, col: 0 } }
          }
          return { state }
        }
        case "up": {
          const layout = layoutInput(state, cols)
          const target = positionAtVisualRow(state, cols, layout.cursorVisualRow - 1)
          if (target !== undefined) {
            return { state: { ...state, row: target.row, col: target.col } }
          }
          return { state }
        }
        case "down": {
          const layout = layoutInput(state, cols)
          const target = positionAtVisualRow(state, cols, layout.cursorVisualRow + 1)
          if (target !== undefined) {
            return { state: { ...state, row: target.row, col: target.col } }
          }
          return { state }
        }
      }
      return { state }
    }
    case "home":
      return { state: { ...state, col: 0 } }
    case "end":
      return {
        state: { ...state, col: (state.lines[state.row] ?? "").length },
      }
    case "delete": {
      const lines = state.lines.slice()
      const cur = lines[state.row] ?? ""
      if (state.col < cur.length) {
        lines[state.row] = cur.slice(0, state.col) + cur.slice(state.col + 1)
        return { state: { ...state, lines } }
      }
      if (state.row < lines.length - 1) {
        const nxt = lines[state.row + 1] ?? ""
        lines.splice(state.row, 2, cur + nxt)
        return { state: { ...state, lines } }
      }
      return { state }
    }
    default:
      return { state }
  }
}

const PROMPT_VISIBLE_PREFIX_LEN = 2

/**
 * Render the input region. Returns visual rows with the (visual) cursor
 * position. The caller positions the real terminal cursor accordingly.
 *
 * Lines wrap visually at terminal width. If the rendered region exceeds
 * `maxRows`, the window scrolls so the cursor is visible.
 */
export const renderInput = (
  state: InputState,
  cols: number,
  maxRows = 8,
  prompt: PromptStyle = PROMPTS.message,
): {
  readonly lines: string[]
  readonly cursorRow: number
  readonly cursorCol: number
} => {
  const layout = layoutInput(state, cols, prompt)
  const styled = layout.visualLines.map((line, i) => {
    if (i === 0 && line.startsWith(prompt.plain)) {
      return padRight(prompt.colored + line.slice(prompt.plain.length), cols)
    }
    return padRight(line, cols)
  })

  let cursorRow = layout.cursorVisualRow
  let lines = styled

  if (lines.length > maxRows) {
    // Scroll window so cursor is visible; prefer trailing tail.
    let start = Math.max(0, cursorRow - maxRows + 1)
    if (start + maxRows > lines.length) start = lines.length - maxRows
    lines = lines.slice(start, start + maxRows)
    cursorRow = cursorRow - start
  }

  return {
    lines,
    cursorRow,
    cursorCol: layout.cursorVisualCol,
  }
}

// Keep an unused export marker so consumers know this is exposed.
export { PROMPT_VISIBLE_PREFIX_LEN }
