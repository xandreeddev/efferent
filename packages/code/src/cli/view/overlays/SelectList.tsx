import { createMemo, For, Show } from "solid-js"
import type { SelectOption, SelectState } from "../../presentation/selectBox.js"
import { glyph, tokens } from "../../state/theme.js"
import { Cursor, Modal, MODAL_RULE, MODAL_WIDTH, Rule } from "../ui/index.js"

const MAX_ROWS = 12
const LABEL_BUDGET = MODAL_RULE - 2 // inner content width minus the "▸ " marker column

/** Truncate to fit the modal so long labels (conversation names, model ids)
 *  don't overflow the border. Active rows reserve room for the " ◀ active" tag. */
const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

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
    if (idx === s().selected) return glyph.pointer
    if (pos === 0 && w.moreAbove) return glyph.more.above
    if (pos === w.rows - 1 && w.moreBelow) return glyph.more.below
    return " "
  }

  return (
    <Modal title={s().title} width={MODAL_WIDTH}>
      {/* filter line + a cursor block */}
      <box flexDirection="row">
        <text fg={tokens.text.muted} wrapMode="none">{`/ ${s().filter}`}</text>
        <Cursor />
      </box>
      <Rule width={MODAL_RULE} />

      <Show
        when={n() > 0}
        fallback={<text fg={tokens.text.muted}>(no matches)</text>}
      >
        <For each={visible()}>
          {(row) => {
            const sel = () => row.idx === s().selected
            return (
              <box flexDirection="row" {...(sel() ? { backgroundColor: tokens.cursorLine } : {})}>
                <text fg={sel() ? tokens.accent.conversation : tokens.text.muted}>
                  {`${marker(row.idx, row.pos)} `}
                </text>
                <text fg={sel() ? tokens.text.default : tokens.text.muted} wrapMode="none" flexGrow={1}>
                  {truncate(row.opt.label, row.opt.active === true ? LABEL_BUDGET - 9 : LABEL_BUDGET)}
                </text>
                <Show when={row.opt.active === true}>
                  <text fg={tokens.text.muted}>{` ${glyph.activeTag} active`}</text>
                </Show>
              </box>
            )
          }}
        </For>
      </Show>

      <Rule width={MODAL_RULE} />
      <box flexDirection="row">
        <text fg={tokens.text.muted} flexGrow={1}>
          ↑↓ move · type filter · ↵ select · esc cancel
        </text>
        <text fg={tokens.text.muted}>{n() === 0 ? "0/0" : `${s().selected + 1}/${n()}`}</text>
      </box>
    </Modal>
  )
}
