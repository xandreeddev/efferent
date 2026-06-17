import { createMemo, For, Show } from "solid-js"
import type { SelectOption, SelectState } from "../../presentation/selectBox.js"
import { themes } from "../../presentation/theme/index.js"
import { glyph, tokens } from "../../state/theme.js"
import { Cursor, Modal, MODAL_WIDTH } from "../ui/index.js"
import { THEME_PREVIEW_W, ThemePreview } from "./ThemePreview.js"

const MAX_ROWS = 12
const LABEL_BUDGET = MODAL_WIDTH - 4 // inner content width minus the "> " marker column

// A picker carrying a side preview (e.g. `:theme`) widens the panel to seat the
// list + the preview pane + a 1-col gap.
const PREVIEW_MODAL_WIDTH = MODAL_WIDTH + THEME_PREVIEW_W + 1

/** A single blank row — the agy menus breathe with blank lines between sections. */
const Gap = () => <text> </text>

/** Truncate to fit the panel so long labels (conversation names, model ids)
 *  don't overflow. Active rows reserve room for the " ◀ active" tag. */
const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

/**
 * The select menu (`:model`/`:theme`/`:search`/`:effort`/picker) — agy-style:
 * borderless (the `Modal` panel draws no box), left-aligned, a `Search:` filter
 * line, a `>` cursor over a window of matches that follows the highlight, and an
 * agy footer. `:theme` additionally seats a live preview pane on the right. Pure
 * view: nav/filter come from `keys/overlay.ts`.
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
    if (idx === s().selected) return glyph.prompt
    if (pos === 0 && w.moreAbove) return glyph.more.above
    if (pos === w.rows - 1 && w.moreBelow) return glyph.more.below
    return " "
  }

  // A side preview (`:theme`) widens the panel and seats a preview pane painted
  // in the HIGHLIGHTED option's theme — the option's value is the theme name.
  const hasPreview = () => s().preview === "theme"
  const previewTokens = () => themes[String(s().matches[s().selected]?.value ?? "")]?.tokens
  const modalWidth = () => (hasPreview() ? PREVIEW_MODAL_WIDTH : MODAL_WIDTH)

  const List = () => (
    <Show when={n() > 0} fallback={<text fg={tokens.text.muted}>{"  (no matches)"}</text>}>
      <For each={visible()}>
        {(row) => {
          const sel = () => row.idx === s().selected
          return (
            <box flexDirection="row">
              <text fg={sel() ? tokens.accent.conversation : tokens.text.muted} flexShrink={0}>
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
  )

  return (
    <Modal title={s().title} width={modalWidth()}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={tokens.text.muted} wrapMode="none">{`  Search: ${s().filter}`}</text>
        <Cursor />
      </box>
      <Gap />

      <Show when={hasPreview()} fallback={<List />}>
        <box flexDirection="row">
          <box flexDirection="column" flexGrow={1}>
            <List />
          </box>
          <box width={1} />
          <Show when={previewTokens() !== undefined}>
            <ThemePreview tokens={previewTokens()!} />
          </Show>
        </box>
      </Show>

      <Gap />
      <box flexDirection="row">
        <text fg={tokens.text.muted} flexGrow={1} wrapMode="none">
          {"  ↑/↓ Navigate · enter Select · tab Complete"}
        </text>
        <text fg={tokens.text.muted}>{n() === 0 ? "0/0 " : `${s().selected + 1}/${n()} `}</text>
      </box>
    </Modal>
  )
}
