import { For, Show } from "solid-js"
import type { SettingsRow, SettingsState } from "../../presentation/settingsView.js"
import { glyph, tokens } from "../../presentation/theme/index.js"
import { Cursor, Modal, MODAL_RULE, MODAL_WIDTH, Rule } from "../ui/index.js"

const LABEL_W = 14
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))

/**
 * The `:settings` table overlay, driving the pure `SettingsState`
 * (`presentation/settingsView.ts`). Each row shows a label + its value; the
 * focused row tints; an inline number edit shows a live buffer + cursor.
 * Nav/toggle/cycle/edit come from `keys/overlay.ts`; the shared `Modal` owns the
 * chrome.
 */
export const SettingsView = (props: { state: SettingsState }) => {
  const s = () => props.state
  const editingIdx = () => (s().editBuffer !== undefined ? s().cursor : -1)

  const Row = (p: { row: SettingsRow; idx: number }) => {
    const focused = () => p.idx === s().cursor
    const editing = () => p.idx === editingIdx()
    return (
      <box flexDirection="row" {...(focused() ? { backgroundColor: tokens.cursorLine } : {})}>
        <text fg={focused() ? tokens.accent.conversation : tokens.text.muted}>
          {focused() ? `${glyph.pointer} ` : "  "}
        </text>
        <text fg={tokens.text.muted}>{pad(p.row.label, LABEL_W)} </text>
        <Show
          when={editing()}
          fallback={
            <text fg={p.row.kind === "readonly" ? tokens.text.muted : tokens.text.default} wrapMode="none" flexGrow={1}>
              {p.row.value.length > 0 ? p.row.value : "default"}
            </text>
          }
        >
          <text fg={tokens.text.default} wrapMode="none">
            {s().editBuffer ?? ""}
          </text>
          <Cursor />
        </Show>
        <Show when={p.row.hint !== undefined && !editing()}>
          <text fg={tokens.text.dim}>{`  ${p.row.hint}`}</text>
        </Show>
      </box>
    )
  }

  return (
    <Modal title={s().title} width={MODAL_WIDTH}>
      <Rule width={MODAL_RULE} />
      <For each={s().rows}>{(row, i) => <Row row={row} idx={i()} />}</For>
      <Rule width={MODAL_RULE} />
      <box flexDirection="row">
        <text fg={tokens.text.muted} flexGrow={1}>
          {s().editBuffer !== undefined
            ? "type a value · ↵ save · esc cancel"
            : "↑↓ move · ↵ toggle / cycle / edit · esc close"}
        </text>
        <text fg={tokens.text.muted}>{`${s().cursor + 1}/${s().rows.length}`}</text>
      </box>
    </Modal>
  )
}
