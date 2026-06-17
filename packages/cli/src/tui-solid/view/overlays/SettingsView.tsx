import { For, Show } from "solid-js"
import type { SettingsRow, SettingsState } from "../../presentation/settingsView.js"
import { currentRow } from "../../presentation/settingsView.js"
import { glyph, tokens } from "../../state/theme.js"
import { Cursor, Modal, MODAL_RULE, MODAL_WIDTH, Rule } from "../ui/index.js"

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

  // Build the full settings table as a single multiline string
  const settingsText = () => {
    const lines: string[] = []
    for (let i = 0; i < s().rows.length; i++) {
      const row = s().rows[i]!
      const isFocused = i === s().cursor
      const isEditing = i === editingIdx()

      // Cursor + label
      const cursor = isFocused ? glyph.pointer : " "
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

      // Truncate hint for inline display
      let hint = ""
      if (row.hint !== undefined && !isEditing) {
        const hintWords = row.hint.split(" ")
        if (hintWords.length > 0) {
          hint = `  ${hintWords[0]}`
        }
      }

      lines.push(`${cursor}${label}${value}${hint}`)
    }
    return lines.join("\n")
  }

  const focusedHint = () => focused()?.hint

  return (
    <Modal title={s().title} width={MODAL_WIDTH}>
      <Rule width={MODAL_RULE} />
      {/* Render the entire table as a single text block */}
      <text fg={tokens.text.default} wrapMode="none">{settingsText()}</text>
      <Rule width={MODAL_RULE} />
      <Show when={focusedHint !== undefined}>
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
