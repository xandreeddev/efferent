import { For, Show } from "solid-js"
import {
  HELP_VISIBLE,
  type HelpState,
  type HelpTab,
  helpRows,
} from "../../presentation/helpView.js"
import { tokens } from "../../state/theme.js"
import { Modal } from "../ui/index.js"

const HELP_WIDTH = 84
/** Keys column width — commands are short names, shortcuts can be long combos. */
const keyCol = (tab: HelpTab) => (tab === "commands" ? 16 : 26)
const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length))
/** A single blank row — the agy menus breathe with blank lines between sections. */
const Gap = () => <text> </text>

/**
 * The `:help` / `?` reference overlay (Feature 2) — a tabbed, scrollable list of
 * every `:` command (the `commands` tab, derived from `SLASH_COMMANDS`) and every
 * keybind (the `shortcuts` tab, the `KEYBINDINGS` catalogue). Pure view: tab
 * cycle + scroll come from `keys/overlay.ts` driving `presentation/helpView.ts`.
 */
export const HelpView = (props: { state: HelpState }) => {
  const s = () => props.state
  const rows = () => helpRows(s().tab)
  const visible = () => rows().slice(s().scroll, s().scroll + HELP_VISIBLE)
  const tab = (t: HelpTab, label: string) => (
    <text fg={s().tab === t ? tokens.accent.side : tokens.text.muted}>{` ${label} `}</text>
  )

  return (
    <Modal title="" width={HELP_WIDTH}>
      {/* the tab bar is the heading (agy-style) */}
      <box flexDirection="row" flexShrink={0}>
        <text fg={tokens.text.dim}>{"efferent  "}</text>
        {tab("commands", "commands")}
        {tab("shortcuts", "shortcuts")}
        <text fg={tokens.text.dim}>{"  (←/→ or tab to cycle)"}</text>
      </box>
      <Gap />

      <For each={visible()}>
        {(row) =>
          row.kind === "head" ? (
            <text fg={tokens.text.heading}>{row.text}</text>
          ) : (
            <box flexDirection="row">
              <text fg={tokens.text.default} wrapMode="none">{`  ${pad(row.keys, keyCol(s().tab))}`}</text>
              <text fg={tokens.text.muted} flexGrow={1}>
                {row.description}
              </text>
            </box>
          )
        }
      </For>

      <Gap />
      <box flexDirection="row">
        <text fg={tokens.text.muted} flexGrow={1}>
          {"  ↑/↓ scroll · ←/→ switch · esc close"}
        </text>
        <Show when={rows().length > HELP_VISIBLE}>
          <text fg={tokens.text.muted}>
            {`${Math.min(s().scroll + HELP_VISIBLE, rows().length)}/${rows().length} `}
          </text>
        </Show>
      </box>
    </Modal>
  )
}
