import type { InputAction, InputState, InputUpdate } from "./input.js"
import { applyKey, inputText, layoutInput } from "./input.js"
import type { Key } from "./keys.js"

export type ViMode = "insert" | "normal"

export interface ViState {
  readonly mode: ViMode
  /** Multi-key pending operator: "d" for dd/dw, "g" for gg. */
  readonly pending?: "d" | "g"
  /** One-level undo snapshot, captured when leaving insert mode. */
  readonly lastUndo?: InputState
}

export const initialVi: ViState = { mode: "insert" }

export interface ViUpdate {
  readonly vi: ViState
  readonly input: InputState
  readonly action?: InputAction
}

const WORD = /\w/

const lineAt = (s: InputState, row: number): string => s.lines[row] ?? ""

const setCursor = (s: InputState, row: number, col: number): InputState => {
  const clampedRow = Math.max(0, Math.min(s.lines.length - 1, row))
  const lineLen = lineAt(s, clampedRow).length
  const clampedCol = Math.max(0, Math.min(lineLen, col))
  return { ...s, row: clampedRow, col: clampedCol }
}

const deleteRange = (
  s: InputState,
  fromRow: number,
  fromCol: number,
  toRow: number,
  toCol: number,
): InputState => {
  if (fromRow === toRow) {
    const cur = lineAt(s, fromRow)
    const lines = s.lines.slice()
    lines[fromRow] = cur.slice(0, fromCol) + cur.slice(toCol)
    return setCursor({ ...s, lines }, fromRow, fromCol)
  }
  const first = lineAt(s, fromRow)
  const last = lineAt(s, toRow)
  const lines = s.lines.slice()
  lines.splice(
    fromRow,
    toRow - fromRow + 1,
    first.slice(0, fromCol) + last.slice(toCol),
  )
  return setCursor({ ...s, lines }, fromRow, fromCol)
}

const motionWordForward = (s: InputState): { row: number; col: number } => {
  let row = s.row
  let col = s.col
  let cur = lineAt(s, row)
  // skip the current word
  while (col < cur.length && WORD.test(cur[col]!)) col++
  // skip whitespace
  while (col < cur.length && !WORD.test(cur[col]!)) col++
  if (col >= cur.length && row < s.lines.length - 1) {
    row++
    cur = lineAt(s, row)
    col = 0
    while (col < cur.length && !WORD.test(cur[col]!)) col++
  }
  return { row, col }
}

const motionWordBack = (s: InputState): { row: number; col: number } => {
  let row = s.row
  let col = s.col
  if (col === 0 && row > 0) {
    row--
    col = lineAt(s, row).length
  }
  let cur = lineAt(s, row)
  while (col > 0 && !WORD.test(cur[col - 1] ?? "")) col--
  while (col > 0 && WORD.test(cur[col - 1] ?? "")) col--
  return { row, col }
}

const motionWordEnd = (s: InputState): { row: number; col: number } => {
  let row = s.row
  let col = s.col
  let cur = lineAt(s, row)
  // if we're already at end-of-word, advance one
  if (col < cur.length - 1 && WORD.test(cur[col]!) && !WORD.test(cur[col + 1] ?? "")) {
    col++
  }
  while (col < cur.length && !WORD.test(cur[col]!)) col++
  if (col >= cur.length && row < s.lines.length - 1) {
    row++
    cur = lineAt(s, row)
    col = 0
  }
  while (col < cur.length - 1 && WORD.test(cur[col + 1] ?? "")) col++
  return { row, col }
}

const deleteWord = (s: InputState): InputState => {
  const target = motionWordForward(s)
  // dw deletes to start of next word; if we ended up on next line, delete to end of current
  if (target.row !== s.row) {
    const cur = lineAt(s, s.row)
    return deleteRange(s, s.row, s.col, s.row, cur.length)
  }
  return deleteRange(s, s.row, s.col, target.row, target.col)
}

const deleteLine = (s: InputState): InputState => {
  if (s.lines.length === 1) {
    return setCursor({ ...s, lines: [""] }, 0, 0)
  }
  const lines = s.lines.slice()
  lines.splice(s.row, 1)
  const newRow = Math.min(s.row, lines.length - 1)
  return setCursor({ ...s, lines }, newRow, 0)
}

const visualUpDown = (
  s: InputState,
  cols: number,
  delta: number,
): InputState => {
  const layout = layoutInput(s, cols)
  const targetVisualRow = layout.cursorVisualRow + delta
  if (targetVisualRow < 0 || targetVisualRow >= layout.visualLines.length) {
    return s
  }
  for (let r = 0; r < layout.lineLayouts.length; r++) {
    const ll = layout.lineLayouts[r]!
    if (
      targetVisualRow >= ll.visualStartRow &&
      targetVisualRow < ll.visualStartRow + ll.chunks.length
    ) {
      const chunkIdx = targetVisualRow - ll.visualStartRow
      const baseCol = ll.chunkStarts[chunkIdx] ?? 0
      const within = Math.max(0, layout.cursorVisualCol - 2)
      const chunkLen = (ll.chunks[chunkIdx] ?? "").length
      return setCursor(s, r, baseCol + Math.min(within, chunkLen))
    }
  }
  return s
}

const captureSnapshot = (s: InputState): InputState => ({
  lines: s.lines.slice(),
  row: s.row,
  col: s.col,
  locked: s.locked,
})

const enterInsert = (vi: ViState, snapshot: InputState): ViState => ({
  mode: "insert",
  ...(vi.lastUndo !== undefined ? { lastUndo: vi.lastUndo } : { lastUndo: snapshot }),
})

const normalKey = (
  vi: ViState,
  s: InputState,
  key: Key,
  cols: number,
): ViUpdate => {
  // Handle pending two-key operators first.
  if (vi.pending === "d") {
    if (key.type === "char" && key.char === "d") {
      return {
        vi: { mode: "normal", lastUndo: captureSnapshot(s) },
        input: deleteLine(s),
      }
    }
    if (key.type === "char" && key.char === "w") {
      return {
        vi: { mode: "normal", lastUndo: captureSnapshot(s) },
        input: deleteWord(s),
      }
    }
    // Any other key cancels the pending operator.
    return { vi: { mode: "normal" }, input: s }
  }
  if (vi.pending === "g") {
    if (key.type === "char" && key.char === "g") {
      return { vi: { mode: "normal" }, input: setCursor(s, 0, 0) }
    }
    return { vi: { mode: "normal" }, input: s }
  }

  // Forward Ctrl-C / Enter / Backspace etc. — they're not vi commands.
  if (key.type === "ctrl" && key.char === "c") {
    return { vi, input: s, action: { type: "exit" } }
  }
  if (key.type === "enter") {
    const text = inputText(s)
    if (text.trim().length === 0) return { vi, input: s }
    return { vi: initialVi, input: s, action: { type: "submit", text } }
  }
  if (key.type === "paste") {
    return { vi, input: applyKey(s, key, cols).state }
  }

  if (key.type === "arrow") {
    return { vi, input: applyKey(s, key, cols).state }
  }

  if (key.type !== "char") return { vi, input: s }

  switch (key.char) {
    // Motions
    case "h":
      return { vi, input: setCursor(s, s.row, s.col - 1) }
    case "l":
      return { vi, input: setCursor(s, s.row, s.col + 1) }
    case "j":
      return { vi, input: visualUpDown(s, cols, 1) }
    case "k":
      return { vi, input: visualUpDown(s, cols, -1) }
    case "w": {
      const p = motionWordForward(s)
      return { vi, input: setCursor(s, p.row, p.col) }
    }
    case "b": {
      const p = motionWordBack(s)
      return { vi, input: setCursor(s, p.row, p.col) }
    }
    case "e": {
      const p = motionWordEnd(s)
      return { vi, input: setCursor(s, p.row, p.col) }
    }
    case "0":
      return { vi, input: setCursor(s, s.row, 0) }
    case "$":
      // Land on the last character (vim), not the column past it.
      return { vi, input: setCursor(s, s.row, lineAt(s, s.row).length - 1) }
    case "g":
      return { vi: { ...vi, pending: "g" }, input: s }
    case "G":
      return {
        vi,
        input: setCursor(
          s,
          s.lines.length - 1,
          lineAt(s, s.lines.length - 1).length,
        ),
      }

    // Inserts
    case "i":
      return { vi: enterInsert(vi, captureSnapshot(s)), input: s }
    case "a":
      return {
        vi: enterInsert(vi, captureSnapshot(s)),
        input: setCursor(s, s.row, s.col + 1),
      }
    case "I":
      return {
        vi: enterInsert(vi, captureSnapshot(s)),
        input: setCursor(s, s.row, 0),
      }
    case "A":
      return {
        vi: enterInsert(vi, captureSnapshot(s)),
        input: setCursor(s, s.row, lineAt(s, s.row).length),
      }
    case "o": {
      const lines = s.lines.slice()
      lines.splice(s.row + 1, 0, "")
      const ns = setCursor({ ...s, lines }, s.row + 1, 0)
      return { vi: enterInsert(vi, captureSnapshot(s)), input: ns }
    }
    case "O": {
      const lines = s.lines.slice()
      lines.splice(s.row, 0, "")
      const ns = setCursor({ ...s, lines }, s.row, 0)
      return { vi: enterInsert(vi, captureSnapshot(s)), input: ns }
    }

    // Edits
    case "x": {
      const cur = lineAt(s, s.row)
      if (s.col >= cur.length) return { vi, input: s }
      const lines = s.lines.slice()
      lines[s.row] = cur.slice(0, s.col) + cur.slice(s.col + 1)
      const snap = captureSnapshot(s)
      return {
        vi: { mode: "normal", lastUndo: snap },
        input: setCursor({ ...s, lines }, s.row, s.col),
      }
    }
    case "d":
      return { vi: { ...vi, pending: "d" }, input: s }

    // Undo
    case "u":
      if (vi.lastUndo !== undefined) {
        return { vi: { mode: "normal" }, input: vi.lastUndo }
      }
      return { vi, input: s }
  }
  // Unknown key in normal mode: silently ignore (no text insertion).
  return { vi, input: s }
}

const insertKey = (
  vi: ViState,
  s: InputState,
  key: Key,
  cols: number,
): ViUpdate => {
  if (key.type === "escape") {
    // vim parks the normal-mode cursor *on* a character, not past the end:
    // leaving insert moves it left one so the first edit (x / dw / ...)
    // operates on the text just typed instead of empty space.
    return {
      vi: { mode: "normal", lastUndo: captureSnapshot(s) },
      input: setCursor(s, s.row, s.col - 1),
    }
  }
  const update: InputUpdate = applyKey(s, key, cols)
  if (update.action !== undefined) {
    return { vi, input: update.state, action: update.action }
  }
  return { vi, input: update.state }
}

export const applyViKey = (
  vi: ViState,
  s: InputState,
  key: Key,
  cols: number,
): ViUpdate =>
  vi.mode === "insert" ? insertKey(vi, s, key, cols) : normalKey(vi, s, key, cols)
