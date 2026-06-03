/**
 * A pure settings modal — a navigable list of settings rows with inline
 * editing, the sibling of `selectBox.ts` / `promptBox.ts`. Replaces the old
 * `:settings` scrollback dump with a proper in-app surface: arrow through the
 * rows, Enter toggles a boolean or opens an inline editor for a number; the
 * read-only rows (`model`, `database`) defer to `:model` / `:db`.
 *
 * Pure: state + reducers + an `OverlayLine[]` renderer composited by
 * `render.ts`, like the other overlays. The driver runs the persistence.
 */

import type { OverlayLine } from "./modal.js"
import { ansi, padRight, truncate, visibleLength } from "./terminal.js"

/** A single settings row. */
export interface SettingsRow {
  /** The `Settings` key this row edits (read-only rows use a synthetic key). */
  readonly key: string
  /** Left-column label. */
  readonly label: string
  /** Current value, formatted for display. */
  readonly value: string
  /** How Enter behaves on this row. */
  readonly kind: "boolean" | "number" | "readonly"
  /** A dim trailing hint (e.g. "use :model"). */
  readonly hint?: string
}

export interface SettingsState {
  readonly title: string
  readonly rows: ReadonlyArray<SettingsRow>
  /** Index of the highlighted row. */
  readonly cursor: number
  /** When editing a number row, the in-progress buffer; else undefined. */
  readonly editBuffer?: string
}

export const openSettings = (
  rows: ReadonlyArray<SettingsRow>,
  title = "Settings",
): SettingsState => ({ title, rows, cursor: 0 })

export const moveSettings = (
  state: SettingsState,
  dir: "up" | "down",
): SettingsState => {
  // Movement is disabled while an inline edit is open.
  if (state.editBuffer !== undefined) return state
  const n = state.rows.length
  if (n === 0) return state
  const cursor =
    dir === "up" ? (state.cursor - 1 + n) % n : (state.cursor + 1) % n
  return { ...state, cursor }
}

export const currentRow = (state: SettingsState): SettingsRow | undefined =>
  state.rows[state.cursor]

/** Begin an inline edit on a number row (seed the buffer with the value). */
export const beginEdit = (state: SettingsState): SettingsState => {
  const row = currentRow(state)
  if (row === undefined || row.kind !== "number") return state
  return { ...state, editBuffer: row.value }
}

export const editAppend = (state: SettingsState, ch: string): SettingsState =>
  state.editBuffer === undefined
    ? state
    : { ...state, editBuffer: state.editBuffer + ch }

export const editBackspace = (state: SettingsState): SettingsState =>
  state.editBuffer === undefined
    ? state
    : { ...state, editBuffer: state.editBuffer.slice(0, -1) }

export const cancelEdit = (state: SettingsState): SettingsState => {
  if (state.editBuffer === undefined) return state
  const { editBuffer: _drop, ...rest } = state
  return rest
}

/**
 * Reflect a committed value back into the row list (so the modal stays open
 * and shows the new value), clearing any edit buffer.
 */
export const setRowValue = (
  state: SettingsState,
  key: string,
  value: string,
): SettingsState => {
  const rows = state.rows.map((r) => (r.key === key ? { ...r, value } : r))
  const { editBuffer: _drop, ...rest } = state
  return { ...rest, rows }
}

/** Whether an inline number edit is currently open. */
export const isEditing = (state: SettingsState): boolean =>
  state.editBuffer !== undefined

/** Render the settings modal as a centered overlay (mirrors the select box). */
export const renderSettingsView = (
  state: SettingsState,
  termRows: number,
  termCols: number,
): OverlayLine[] => {
  const boxWidth = Math.min(76, Math.max(44, termCols - 6))
  const innerWidth = boxWidth - 4
  const listRows = Math.max(1, state.rows.length)
  // title + sep + list + sep + hints, framed (2 borders)
  const totalLines = listRows + 6
  const top = Math.max(1, Math.floor((termRows - totalLines) / 2))
  const left = Math.max(1, Math.floor((termCols - boxWidth) / 2))
  const horiz = "─".repeat(boxWidth - 2)

  const fill = (s: string): string =>
    `${ansi.bgDarkGray}${ansi.fgWhite}${padRight(s, boxWidth)}${ansi.reset}`
  const span = (style: string, text: string): string =>
    `${style}${text}${ansi.reset}${ansi.bgDarkGray}${ansi.fgWhite}`
  const row = (inner: string): string => fill(`│ ${padRight(inner, innerWidth)} │`)

  const out: OverlayLine[] = []
  let r = top
  const emit = (content: string) => {
    out.push({ row: r, col: left, content })
    r += 1
  }

  const LABEL_W = 14

  emit(fill(`╭${horiz}╮`))
  emit(row(span(ansi.fgBrightCyan + ansi.bold, truncate(state.title, innerWidth))))
  emit(fill(`├${horiz}┤`))

  state.rows.forEach((rw, idx) => {
    const focused = idx === state.cursor
    const marker = focused
      ? span(ansi.fgBrightCyan + ansi.bold, "▸")
      : " "
    const label = padRight(truncate(rw.label, LABEL_W), LABEL_W)
    // While editing this row, show the live buffer with a cursor block.
    const editing = focused && state.editBuffer !== undefined
    const valueText = editing
      ? `${state.editBuffer}${span(ansi.fgBrightGreen, "█")}`
      : rw.kind === "readonly"
        ? span(ansi.fgGray, rw.value)
        : span(focused ? ansi.bold : "", rw.value)
    const hint =
      rw.hint !== undefined && !editing ? span(ansi.fgGray, `  ${rw.hint}`) : ""
    emit(row(`${marker} ${span(ansi.fgGray, label)} ${valueText}${hint}`))
  })

  emit(fill(`├${horiz}┤`))
  const hints =
    state.editBuffer !== undefined
      ? "type a value · ↵ save · esc cancel"
      : "↑↓ move · ↵ toggle / edit · esc close"
  const counter = `${state.cursor + 1}/${state.rows.length}`
  emit(
    row(
      `${span(ansi.fgGray, hints)}${" ".repeat(
        Math.max(1, innerWidth - visibleLength(hints) - visibleLength(counter)),
      )}${span(ansi.fgGray, counter)}`,
    ),
  )
  emit(fill(`╰${horiz}╯`))
  return out
}
