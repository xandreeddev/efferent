/**
 * A pure settings modal — a navigable list of settings rows with inline
 * editing, the sibling of `selectBox.ts` / `promptBox.ts`. Replaces the old
 * `:settings` scrollback dump with a proper in-app surface: arrow through the
 * rows, Enter toggles a boolean or opens an inline editor for a number; the
 * read-only rows (`model`, `database`) defer to `:model` / `:db`.
 *
 * Pure: state + reducers. The OpenTUI `SettingsView` component renders it; the
 * driver runs the persistence.
 */

/** A single settings row. */
export interface SettingsRow {
  /** The `Settings` key this row edits (read-only rows use a synthetic key). */
  readonly key: string
  /** Left-column label. */
  readonly label: string
  /** Current value, formatted for display. */
  readonly value: string
  /** How Enter behaves on this row. */
  readonly kind: "boolean" | "number" | "enum" | "readonly"
  /** Allowed values for enum rows; an empty display value means provider default. */
  readonly options?: ReadonlyArray<string>
  /** A dim trailing hint (e.g. "use :model"). */
  readonly hint?: string
  /** A full-sentence description of the setting, shown for the focused row. */
  readonly description?: string
}

export interface SettingsState {
  readonly title: string
  readonly rows: ReadonlyArray<SettingsRow>
  /** Type-to-filter query (matched against label + key); "" shows all rows. */
  readonly filter: string
  /** Index of the highlighted row WITHIN the filtered view ({@link visibleRows}). */
  readonly cursor: number
  /** When editing a number row, the in-progress buffer; else undefined. */
  readonly editBuffer?: string
}

export const openSettings = (
  rows: ReadonlyArray<SettingsRow>,
  title = "Settings",
): SettingsState => ({ title, rows, filter: "", cursor: 0 })

/** The rows currently visible — `rows` narrowed by `filter` (case-insensitive
 *  substring on label or key). The cursor indexes INTO this list. */
export const visibleRows = (state: SettingsState): ReadonlyArray<SettingsRow> => {
  const q = state.filter.trim().toLowerCase()
  if (q.length === 0) return state.rows
  return state.rows.filter(
    (r) => r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q),
  )
}

export const moveSettings = (
  state: SettingsState,
  dir: "up" | "down",
): SettingsState => {
  // Movement is disabled while an inline edit is open.
  if (state.editBuffer !== undefined) return state
  const n = visibleRows(state).length
  if (n === 0) return state
  const cursor =
    dir === "up" ? (state.cursor - 1 + n) % n : (state.cursor + 1) % n
  return { ...state, cursor }
}

export const currentRow = (state: SettingsState): SettingsRow | undefined =>
  visibleRows(state)[state.cursor]

const reFilter = (state: SettingsState, filter: string): SettingsState => {
  const n = visibleRows({ ...state, filter }).length
  const cursor = n === 0 ? 0 : Math.min(state.cursor, n - 1)
  return { ...state, filter, cursor }
}

export const filterAppend = (state: SettingsState, ch: string): SettingsState =>
  state.editBuffer !== undefined ? state : reFilter(state, state.filter + ch)

export const filterBackspace = (state: SettingsState): SettingsState =>
  state.editBuffer !== undefined ? state : reFilter(state, state.filter.slice(0, -1))

export const clearFilter = (state: SettingsState): SettingsState =>
  reFilter(state, "")

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

