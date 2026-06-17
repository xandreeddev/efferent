import { createMemo, For, Show } from "solid-js"
import type { SettingsRow, SettingsState } from "../../presentation/settingsView.js"
import { currentRow } from "../../presentation/settingsView.js"
import { glyph, tokens } from "../../state/theme.js"
import { Cursor, Modal, MODAL_RULE, MODAL_WIDTH, Rule } from "../ui/index.js"

const MAX_ROWS = 12
const LABEL_W = 18
const VALUE_MAX = 14

/**
 * The `:settings` table overlay — renders as pre-formatted multiline text
 * to avoid flex layout corruption entirely.
 */
export const SettingsView = (props: { state: SettingsState }) => {
  const s = () => props.state
  const editingIdx = () => (s().editBuffer !== undefined ? s().cursor : -1)
  const focused = () => currentRow(s())
  const n = () => s().rows.length

  const listRows = () => Math.min(MAX_ROWS, Math.max(1, n()))

  const win = createMemo(() => {
    const rows = listRows()
    let start = s().cursor - Math.floor(rows / 2)
    start = Math.max(0, Math.min(start, Math.max(0, n() - rows)))
    return { start, rows, moreAbove: start > 0, moreBelow: start + rows < n() }
  })

  // Build the settings table window as a single multiline string
  const settingsText = () => {
    const lines: string[] = []
    const w = win()
    for (let pos = 0; pos < w.rows; pos++) {
      const idx = w.start + pos
      const row = s().rows[idx]!
      const isFocused = idx === s().cursor
      const isEditing = idx === editingIdx()

      // Cursor + scroll affordances in the margin
      let marker = " "
      if (isFocused) {
        marker = glyph.pointer
      } else if (pos === 0 && w.moreAbove) {
        marker = glyph.more.above
      } else if (pos === w.rows - 1 && w.moreBelow) {
        marker = glyph.more.below
      }

      const label = row.label.padEnd(LABEL_W, " ")

      // Value
      let value: string
      if (isEditing && s().editBuffer !== undefined) {
        value = s().editBuffer!
      } else {
        value = row.value.length > 0 ? row.value : "default"
        if (value.length > VALUE_MAX) {
          value = `${value.slice(0, VALUE_MAX - 1)}…`
        }
      }

      lines.push(`${marker} ${label}${value}`)
    }
    return lines.join("\n")
  }

  const focusedHint = () => focused()?.hint

  return (
    <Modal title={s().title} width={MODAL_WIDTH}>
      {/* Render the entire table as a single text block */}
      <text fg={tokens.text.default} wrapMode="none">{settingsText()}</text>
      <Rule width={MODAL_RULE} />
      <Show when={focusedHint() !== undefined}>
        <text fg={tokens.text.dim} wrapMode="word" marginTop={1}>
          {focusedHint()}
        </text>
      </Show>
      <Show when={s().editBuffer !== undefined}>
        <text fg={tokens.text.dim} marginTop={1}>
          {"  type a value · ↵ save · esc cancel"}
        </text>
      </Show>
      <Show when={s().editBuffer === undefined}>
        <box flexDirection="row" marginTop={1}>
          <text fg={tokens.text.muted} flexGrow={1}>
            ↑↓ move · ↵ toggle / cycle / edit · esc close
          </text>
          <text fg={tokens.text.muted}>{`${s().cursor + 1}/${s().rows.length}`}</text>
        </box>
      </Show>
    </Modal>
  )
}
