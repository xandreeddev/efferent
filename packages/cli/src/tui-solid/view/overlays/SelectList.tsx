import { createMemo, For, Show } from "solid-js"
import type { SelectOption, SelectState } from "../../../tui/selectBox.js"
import { theme } from "../../theme.js"

const MAX_ROWS = 12

/**
 * A centered, navigable list overlay — the OpenTUI analogue of `renderSelectBox`,
 * driving the same pure `SelectState` (`tui/selectBox.ts`). Renders the title,
 * a type-to-filter line, a window of matches that follows the highlight, and a
 * counter/hint footer. Pure view: nav/filter come from `keys/overlay.ts`.
 */
export const SelectList = (props: { state: SelectState<unknown> }) => {
  const s = () => props.state
  const n = () => s().matches.length
  const listRows = () => Math.min(MAX_ROWS, Math.max(1, n()))

  const win = createMemo(() => {
    const rows = listRows()
    let start = s().selected - Math.floor(rows / 2)
    start = Math.max(0, Math.min(start, Math.max(0, n() - rows)))
    return { start, rows, moreAbove: start > 0, moreBelow: start + rows < n() }
  })

  const visible = createMemo(() => {
    const { start, rows } = win()
    return s()
      .matches.slice(start, start + rows)
      .map((opt, i) => ({ opt: opt as SelectOption<unknown>, idx: start + i, pos: i }))
  })

  const marker = (idx: number, pos: number): string => {
    const w = win()
    if (idx === s().selected) return "▸"
    if (pos === 0 && w.moreAbove) return "↑"
    if (pos === w.rows - 1 && w.moreBelow) return "↓"
    return " "
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
      {/* filter line + a green cursor block */}
      <box flexDirection="row">
        <text fg={theme.gray} wrapMode="none">{`/ ${s().filter}`}</text>
        <text fg={theme.select}>█</text>
      </box>
      <text fg={theme.dim}>{"─".repeat(68)}</text>

      <Show
        when={n() > 0}
        fallback={<text fg={theme.gray}>(no matches)</text>}
      >
        <For each={visible()}>
          {(row) => {
            const sel = () => row.idx === s().selected
            return (
              <box flexDirection="row" {...(sel() ? { backgroundColor: theme.cursorLine } : {})}>
                <text fg={sel() ? theme.accent.conversation : theme.gray}>
                  {`${marker(row.idx, row.pos)} `}
                </text>
                <text fg={sel() ? theme.text : theme.gray} wrapMode="none" flexGrow={1}>
                  {row.opt.label}
                </text>
                <Show when={row.opt.active === true}>
                  <text fg={theme.gray}> ◀ active</text>
                </Show>
              </box>
            )
          }}
        </For>
      </Show>

      <text fg={theme.dim}>{"─".repeat(68)}</text>
      <box flexDirection="row">
        <text fg={theme.gray} flexGrow={1}>
          ↑↓ move · type filter · ↵ select · esc cancel
        </text>
        <text fg={theme.gray}>{n() === 0 ? "0/0" : `${s().selected + 1}/${n()}`}</text>
      </box>
    </box>
  )
}
