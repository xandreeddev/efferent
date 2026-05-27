import { ansi, padRight, truncate, visibleLength } from "./terminal.js"
import type { Key } from "./keys.js"

export interface InputState {
  /** Lines of the current input (multi-line via Shift-Enter). */
  readonly lines: ReadonlyArray<string>
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
  | { readonly type: "cancel" }
  | { readonly type: "exit" }
  | { readonly type: "clearScrollback" }

export interface InputUpdate {
  readonly state: InputState
  readonly action?: InputAction
}

export const applyKey = (state: InputState, key: Key): InputUpdate => {
  if (state.locked) {
    if (key.type === "ctrl" && key.char === "c") {
      return { state, action: { type: "cancel" } }
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
      lines.splice(
        state.row,
        1,
        before + first,
        ...middle,
        last + after,
      )
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
      // Plain Enter submits when there's content; Shift-Enter inserts a newline.
      // (Most terminals don't distinguish Shift-Enter without protocol opt-in;
      // we use Ctrl-J / Alt-Enter convention via the "ctrl" path below.)
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
          return { state, action: { type: "cancel" } }
        case "d":
          if (isEmpty(state)) return { state, action: { type: "exit" } }
          return { state }
        case "l":
          return { state, action: { type: "clearScrollback" } }
        case "j": {
          // Newline within input.
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
          // delete word
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
        case "up":
          if (state.row > 0) {
            const prev = state.lines[state.row - 1] ?? ""
            return {
              state: { ...state, row: state.row - 1, col: Math.min(state.col, prev.length) },
            }
          }
          return { state }
        case "down":
          if (state.row < state.lines.length - 1) {
            const nxt = state.lines[state.row + 1] ?? ""
            return {
              state: { ...state, row: state.row + 1, col: Math.min(state.col, nxt.length) },
            }
          }
          return { state }
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

const PROMPT = `${ansi.fgBrightGreen}❯${ansi.reset} `
const CONT = "  "

/**
 * Render the input region. Returns an array of lines exactly `rows` rows
 * tall, with the cursor position (row, col) within the rendered region —
 * the caller positions the real terminal cursor accordingly.
 */
export const renderInput = (
  state: InputState,
  cols: number,
): { readonly lines: string[]; readonly cursorRow: number; readonly cursorCol: number } => {
  const lines: string[] = []
  for (let r = 0; r < state.lines.length; r++) {
    const prefix = r === 0 ? PROMPT : CONT
    const visible = padRight(prefix + (state.lines[r] ?? ""), cols)
    lines.push(truncate(visible, cols))
  }
  if (state.locked) {
    lines[lines.length - 1] = `${ansi.dim}${ansi.fgGray}thinking…${ansi.reset}`
  }
  const cursorRow = state.row
  const cursorCol =
    visibleLength(state.row === 0 ? PROMPT : CONT) + state.col
  return { lines, cursorRow, cursorCol }
}
