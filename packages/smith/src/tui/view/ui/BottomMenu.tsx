import { createMemo, For, Show } from "solid-js"
import { glyph, tokens } from "../../theme.js"
import { KeyHints, MenuRow } from "./atoms.js"
import type { KeyHint } from "./atoms.js"

/** One row of a bottom menu — what every picker feeds the shared renderer. */
export interface BottomMenuItem {
  readonly label: string
  readonly desc?: string | undefined
  readonly tag?: string | undefined
  readonly active?: boolean | undefined
}

/** Default visible-row window for an inline bottom menu. */
export const BOTTOM_MENU_ROWS = 8

/**
 * The borderless inline contextual menu — the single renderer for every
 * picker that drops below the composer. NOT a modal: no border, no surface;
 * an optional title, a windowed row list with dim `↑/↓ N more` overflow
 * lines, a blank line, then an indented `KeyHints` footer. Selection is the
 * `>` pointer + the row in the selection accent; the window follows the
 * highlight.
 */
export const BottomMenu = (props: {
  items: ReadonlyArray<BottomMenuItem>
  selected: number
  title?: string | undefined
  labelBudget: number
  footer: ReadonlyArray<KeyHint>
  maxRows?: number
}) => {
  const n = () => props.items.length
  const cap = () => props.maxRows ?? BOTTOM_MENU_ROWS
  const rowCount = () => Math.min(cap(), Math.max(1, n()))

  // Window that follows the highlight (centre-ish), clamped to the bounds.
  const win = createMemo(() => {
    const r = rowCount()
    const centred = props.selected - Math.floor(r / 2)
    const start = Math.max(0, Math.min(centred, Math.max(0, n() - r)))
    return { start, rows: r, above: start, below: Math.max(0, n() - (start + r)) }
  })

  const visible = createMemo(() => {
    const { start, rows } = win()
    return props.items.slice(start, start + rows).map((item, i) => ({ item, idx: start + i }))
  })

  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={props.title !== undefined}>
        <text fg={tokens.text.default} wrapMode="none">{props.title}</text>
        <box height={1} />
      </Show>

      <Show
        when={n() > 0}
        fallback={<text fg={tokens.text.dim} wrapMode="none">{"   No matches"}</text>}
      >
        <Show when={win().above > 0}>
          <text fg={tokens.text.dim} wrapMode="none">{`   ${glyph.more.above} ${win().above} more`}</text>
        </Show>
        <For each={visible()}>
          {(row) => {
            const sel = () => row.idx === props.selected
            const tagText = () =>
              row.item.tag !== undefined
                ? row.item.tag
                : row.item.active === true
                  ? "active"
                  : undefined
            const budget = () => {
              const tag = tagText()
              return tag !== undefined ? props.labelBudget - (tag.length + 4) : props.labelBudget
            }
            return (
              <MenuRow
                selected={sel()}
                marker={sel() ? glyph.pointer : " "}
                label={row.item.label}
                labelBudget={budget()}
                desc={row.item.desc}
                tag={tagText()}
                tagActive={row.item.active === true}
              />
            )
          }}
        </For>
        <Show when={win().below > 0}>
          <text fg={tokens.text.dim} wrapMode="none">{`   ${glyph.more.below} ${win().below} more`}</text>
        </Show>
      </Show>

      <box height={1} />
      <box paddingLeft={2}>
        <KeyHints hints={props.footer} />
      </box>
    </box>
  )
}
