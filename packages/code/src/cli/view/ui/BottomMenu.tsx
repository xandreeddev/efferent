import { createMemo, For, Show } from "solid-js"
import { glyph, tokens } from "../../state/theme.js"
import { KeyHints, MenuRow, type KeyHint } from "./atoms.js"

/** One row of a bottom menu — what every contextual menu (command palette +
 *  pickers) feeds the shared renderer. */
export interface BottomMenuItem {
  readonly label: string
  readonly desc?: string | undefined
  readonly tag?: string | undefined
  readonly active?: boolean | undefined
}

/** Default visible-row window for an inline bottom menu (agy shows ~5–8). */
export const BOTTOM_MENU_ROWS = 8

/**
 * The **borderless agy contextual menu** — the single renderer for every menu
 * that drops below the input fence (the `:` command palette AND every picker:
 * model / theme / effort / search / logout / browse / db). NOT a modal: it has
 * no border or surface, it sits inline in the bottom chrome, and it breathes
 * like agy — an optional bold-ish title, a windowed row list with dim
 * `↑/↓ N more` overflow lines, a **blank line**, then a 2-space-indented footer
 * of accent key-chips + dim labels (`KeyHints`).
 *
 * Selection follows agy: the `>` pointer (`glyph.pointer`) + the row in the
 * selection accent. Windowing keeps the selected row in view and reports how many
 * rows are hidden above/below as their own dim lines (not inline arrows), exactly
 * like agy's `↓ 32 more`.
 */
export const BottomMenu = (props: {
  items: ReadonlyArray<BottomMenuItem>
  selected: number
  /** Bold-ish header line (pickers: "Switch model"); omit for the command palette,
   *  where the typed `> :cmd` input line is the context. */
  title?: string | undefined
  labelBudget: number
  footer: ReadonlyArray<KeyHint>
  maxRows?: number
}) => {
  const n = () => props.items.length
  const cap = () => props.maxRows ?? BOTTOM_MENU_ROWS
  const rowCount = () => Math.min(cap(), Math.max(1, n()))

  // Window that follows the highlight (centre-ish), clamped to the list bounds.
  const win = createMemo(() => {
    const r = rowCount()
    let start = props.selected - Math.floor(r / 2)
    start = Math.max(0, Math.min(start, Math.max(0, n() - r)))
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

      <Show when={n() > 0} fallback={<text fg={tokens.text.dim} wrapMode="none">{"   No matches"}</text>}>
        <Show when={win().above > 0}>
          <text fg={tokens.text.dim} wrapMode="none">{`   ${glyph.more.above} ${win().above} more`}</text>
        </Show>
        <For each={visible()}>
          {(row) => {
            const sel = () => row.idx === props.selected
            // The active row carries a trailing tag; `active` rows that set no
            // explicit tag get the generic "active" word (the shared MenuRow rule).
            const tagText = () =>
              row.item.tag !== undefined ? row.item.tag : row.item.active === true ? "active" : undefined
            const budget = () =>
              tagText() !== undefined ? props.labelBudget - (tagText()!.length + 4) : props.labelBudget
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

      {/* The agy "space around the menu": one blank line, then the indented footer. */}
      <box height={1} />
      <box paddingLeft={2}>
        <KeyHints hints={props.footer} />
      </box>
    </box>
  )
}
