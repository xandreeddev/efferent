import { For, Show } from "solid-js"
import type { SettingsRow, SettingsState } from "../../presentation/settingsView.js"
import { visibleRows } from "../../presentation/settingsView.js"
import { glyph, tokens } from "../../state/theme.js"
import { Cursor, Modal, MODAL_WIDTH, Rule } from "../ui/index.js"

const LABEL_W = 16
const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length))
/** A single blank row — the agy menus breathe with blank lines between sections. */
const Gap = () => <text> </text>

/**
 * The `:settings` menu — agy-style: borderless (the `Modal` panel draws no box),
 * left-aligned, a `>` cursor, values in an aligned column, and blank lines
 * between the search / list / description / footer sections. A `Search:` line
 * filters; the focused row's full-sentence description sits above the footer.
 * Nav/filter/toggle/cycle/edit come from `keys/overlay.ts`.
 */
export const SettingsView = (props: { state: SettingsState }) => {
  const s = () => props.state
  const rows = () => visibleRows(s())
  const editing = () => s().editBuffer !== undefined
  const editingIdx = () => (editing() ? s().cursor : -1)
  const focused = () => rows()[s().cursor]

  const Row = (p: { row: SettingsRow; idx: number }) => {
    const isSel = () => p.idx === s().cursor
    const isEd = () => p.idx === editingIdx()
    return (
      <box flexDirection="row">
        <text fg={isSel() ? tokens.accent.conversation : tokens.text.muted} flexShrink={0}>
          {isSel() ? `${glyph.prompt} ` : "  "}
        </text>
        <text fg={isSel() ? tokens.text.default : tokens.text.muted}>{pad(p.row.label, LABEL_W)} </text>
        <Show
          when={isEd()}
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
      </box>
    )
  }

  return (
    <Modal title={s().title} width={MODAL_WIDTH}>
      {/* 2-space-indented Search line + a short rule beneath it (agy) */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={tokens.text.muted} wrapMode="none">{`  Search: ${s().filter}`}</text>
        <Show when={!editing()}>
          <Cursor />
        </Show>
      </box>
      <box flexDirection="row" flexShrink={0}>
        <text wrapMode="none">{"          "}</text>
        <Rule width={20} />
      </box>
      <Gap />
      <For each={rows()}>{(row, i) => <Row row={row} idx={i()} />}</For>
      <Show when={rows().length === 0}>
        <text fg={tokens.text.muted}>{"  (no matching settings)"}</text>
      </Show>
      <Gap />
      {/* full-sentence help for the focused setting (falls back to its hint) */}
      <text fg={tokens.text.dim} wrapMode="word">
        {`  ${focused()?.description ?? focused()?.hint ?? ""}`}
      </text>
      <Gap />
      <box flexDirection="row">
        <text fg={tokens.text.muted} flexGrow={1} wrapMode="none">
          {editing()
            ? "  type a value · enter Save · esc Cancel"
            : "  ↑/↓ Navigate · enter toggle/cycle/edit · esc Clear Search/Exit"}
        </text>
        <text fg={tokens.text.muted}>{`${rows().length === 0 ? 0 : s().cursor + 1}/${rows().length} `}</text>
      </box>
    </Modal>
  )
}
