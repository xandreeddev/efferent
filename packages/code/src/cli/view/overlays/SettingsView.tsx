import { createMemo, For, Show } from "solid-js"
import type { SettingsState } from "../../presentation/settingsView.js"
import { currentRow } from "../../presentation/settingsView.js"
import { glyph, tokens } from "../../state/theme.js"
import { KeyHints, Modal, MODAL_RULE, MODAL_WIDTH, Rule } from "../ui/index.js"

const MAX_ROWS = 12
const LABEL_W = 18
const VALUE_MAX = 14

/**
 * The `:settings` table overlay. Each row is rendered as ONE pre-formatted
 * `<text>` line stacked in a column (never sibling `<text>` in a flex row — that
 * corrupts under OpenTUI/Yoga). The focused row carries the selection accent +
 * cursor-line tint, consistent with `SelectBody` (one accent: `marker.select`).
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

  // One window row → its full pre-formatted text + whether it's the cursor row.
  const rows = createMemo(() => {
    const w = win()
    const out: Array<{ text: string; focused: boolean }> = []
    for (let pos = 0; pos < w.rows; pos++) {
      const idx = w.start + pos
      const row = s().rows[idx]!
      const isFocused = idx === s().cursor
      const isEditing = idx === editingIdx()

      let marker = " "
      if (isFocused) marker = glyph.pointer
      else if (pos === 0 && w.moreAbove) marker = glyph.more.above
      else if (pos === w.rows - 1 && w.moreBelow) marker = glyph.more.below

      const label = row.label.padEnd(LABEL_W, " ")

      let value: string
      if (isEditing && s().editBuffer !== undefined) {
        value = s().editBuffer!
      } else {
        value = row.value.length > 0 ? row.value : "default"
        if (value.length > VALUE_MAX) value = `${value.slice(0, VALUE_MAX - 1)}…`
      }

      out.push({ text: `${marker} ${label}${value}`, focused: isFocused })
    }
    return out
  })

  const focusedHint = () => focused()?.hint

  return (
    <Modal title={s().title} width={MODAL_WIDTH}>
      {/* Per-row column: focused row gets the selection accent + cursor tint;
          the rest are default fg. Single <text> per row (column-stacked) is
          corruption-safe. */}
      <box flexDirection="column">
        <For each={rows()}>
          {(r) => (
            <text
              fg={r.focused ? tokens.marker.select : tokens.text.default}
              wrapMode="none"
              {...(r.focused ? { backgroundColor: tokens.cursorLine } : {})}
            >
              {r.text}
            </text>
          )}
        </For>
      </box>
      <Rule width={MODAL_RULE} />
      <Show when={focusedHint() !== undefined}>
        <text fg={tokens.text.dim} wrapMode="word" marginTop={1}>
          {focusedHint()}
        </text>
      </Show>
      <Show when={s().editBuffer !== undefined}>
        <box marginTop={1}>
          <KeyHints
            hints={[
              { key: "type", label: "a value" },
              { key: "↵", label: "save" },
              { key: "esc", label: "cancel" },
            ]}
          />
        </box>
      </Show>
      <Show when={s().editBuffer === undefined}>
        <box flexDirection="row" marginTop={1}>
          <KeyHints
            hints={[
              { key: "↑/↓", label: "move" },
              { key: "↵", label: "toggle / cycle / edit" },
              { key: "esc", label: "close" },
            ]}
            grow
          />
          <text fg={tokens.text.muted}>{`${s().cursor + 1}/${n()}`}</text>
        </box>
      </Show>
    </Modal>
  )
}
