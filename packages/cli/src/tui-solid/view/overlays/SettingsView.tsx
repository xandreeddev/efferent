import { For, Show } from "solid-js"
import type { SettingsRow, SettingsState } from "../../presentation/settingsView.js"
import { theme } from "../../theme.js"

const LABEL_W = 14
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))

/**
 * The `:settings` table overlay — the OpenTUI analogue of `renderSettingsView`,
 * driving the pure `SettingsState` (`tui/settingsView.ts`). Each row shows a
 * label + its value; the focused row tints; an inline number edit shows a live
 * buffer + cursor. Nav/toggle/cycle/edit come from `keys/overlay.ts`.
 */
export const SettingsView = (props: { state: SettingsState }) => {
  const s = () => props.state
  const editingIdx = () => (s().editBuffer !== undefined ? s().cursor : -1)

  const Row = (p: { row: SettingsRow; idx: number }) => {
    const focused = () => p.idx === s().cursor
    const editing = () => p.idx === editingIdx()
    return (
      <box flexDirection="row" {...(focused() ? { backgroundColor: theme.cursorLine } : {})}>
        <text fg={focused() ? theme.accent.conversation : theme.gray}>{focused() ? "▸ " : "  "}</text>
        <text fg={theme.gray}>{pad(p.row.label, LABEL_W)} </text>
        <Show
          when={editing()}
          fallback={
            <text fg={p.row.kind === "readonly" ? theme.gray : theme.text} wrapMode="none" flexGrow={1}>
              {p.row.value.length > 0 ? p.row.value : "default"}
            </text>
          }
        >
          <text fg={theme.text} wrapMode="none">
            {s().editBuffer ?? ""}
          </text>
          <text fg={theme.select}>█</text>
        </Show>
        <Show when={p.row.hint !== undefined && !editing()}>
          <text fg={theme.dim}>{`  ${p.row.hint}`}</text>
        </Show>
      </box>
    )
  }

  return (
    <box
      flexDirection="column"
      border
      title={` ${s().title} `}
      borderColor={theme.accent.side}
      backgroundColor={theme.overlayBg}
      width={72}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.dim}>{"─".repeat(68)}</text>
      <For each={s().rows}>{(row, i) => <Row row={row} idx={i()} />}</For>
      <text fg={theme.dim}>{"─".repeat(68)}</text>
      <box flexDirection="row">
        <text fg={theme.gray} flexGrow={1}>
          {s().editBuffer !== undefined
            ? "type a value · ↵ save · esc cancel"
            : "↑↓ move · ↵ toggle / cycle / edit · esc close"}
        </text>
        <text fg={theme.gray}>{`${s().cursor + 1}/${s().rows.length}`}</text>
      </box>
    </box>
  )
}
