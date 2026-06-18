import { createMemo, For, Show } from "solid-js"
import type { SelectOption, SelectState } from "../../presentation/selectBox.js"
import { glyph, tokens } from "../../state/theme.js"
import { Cursor, KeyHints, type KeyHint } from "./atoms.js"

/** Default visible-row window. Both the modal `SelectList` and the full-screen
 *  onboarding share this so the list never drifts between surfaces. */
export const SELECT_MAX_ROWS = 12

/** Truncate to fit the available width so long labels (model ids, conversation
 *  names) don't overflow. Active rows reserve room for the " ◀ active" tag. */
const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

/**
 * The inner body of a select overlay — the `/ filter` line, a window of matches
 * that follows the highlight, and a `N/M` counter — WITHOUT any surrounding
 * chrome (no `Modal`, no rules). The single source of truth for select
 * rendering, consumed by both `SelectList` (wrapped in a `Modal`) and the
 * onboarding flow (bare, full-screen). Nav/filter come from `keys/overlay.ts`
 * driving the pure `SelectState`.
 *
 * `labelBudget` is the width available for an option label (the caller knows its
 * own width); `footer` is the hint row shown beneath the list+counter.
 */
export const SelectBody = (props: {
  state: SelectState<unknown>
  labelBudget: number
  footer: ReadonlyArray<KeyHint>
  maxRows?: number
}) => {
  const s = () => props.state
  const n = () => s().matches.length
  // A "manager" list groups rows under section headings (configured items, then
  // add actions). These lists are short, so they render in full (no windowing) —
  // the heading lines would otherwise throw off the fixed-height window math.
  const grouped = () => s().all.some((o) => o.section !== undefined)
  const rowsCap = () => props.maxRows ?? SELECT_MAX_ROWS
  const listRows = () => (grouped() ? Math.max(1, n()) : Math.min(rowsCap(), Math.max(1, n())))

  const win = createMemo(() => {
    const rows = listRows()
    if (grouped()) return { start: 0, rows, moreAbove: false, moreBelow: false }
    let start = s().selected - Math.floor(rows / 2)
    start = Math.max(0, Math.min(start, Math.max(0, n() - rows)))
    return { start, rows, moreAbove: start > 0, moreBelow: start + rows < n() }
  })

  /** The section heading to print above row `idx`, or undefined if this row
   *  continues the previous row's group. Non-empty headings print dim text; an
   *  empty-string section yields just a blank separator (handled by the caller). */
  const headingFor = (idx: number): { sep: boolean; text?: string | undefined } | undefined => {
    const opt = s().matches[idx]
    if (opt?.section === undefined) return undefined
    const prev = idx > 0 ? s().matches[idx - 1]?.section : undefined
    if (prev === opt.section) return undefined
    return { sep: idx > 0, text: opt.section.length > 0 ? opt.section : undefined }
  }

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
    <box flexDirection="column">
      {/* filter line + a cursor block */}
      <box flexDirection="row">
        <text fg={tokens.text.muted} wrapMode="none">{`/ ${s().filter}`}</text>
        <Cursor />
      </box>
      <box height={1} />

      <Show when={n() > 0} fallback={<text fg={tokens.text.muted}>(no matches)</text>}>
        <For each={visible()}>
          {(row) => {
            const sel = () => row.idx === s().selected
            const head = () => headingFor(row.idx)
            // A row carries a trailing tag when it sets one explicitly (`tag`)
            // or is flagged `active` (the generic "active" word). The tag steals
            // label width so a long label can't shove it off the row.
            const tagText = () =>
              row.opt.tag !== undefined ? row.opt.tag : row.opt.active === true ? "active" : undefined
            const budget = () =>
              tagText() !== undefined ? props.labelBudget - (tagText()!.length + 4) : props.labelBudget
            return (
              <>
                {/* Section heading (manager layout): a blank separator above each
                    new group plus a dim heading line when the group is named. */}
                <Show when={head()}>
                  {(h) => (
                    <>
                      <Show when={h().sep}>
                        <box height={1} />
                      </Show>
                      <Show when={h().text !== undefined}>
                        <text fg={tokens.text.dim} wrapMode="none">{`  ${h().text}`}</text>
                      </Show>
                    </>
                  )}
                </Show>
                <box flexDirection="row" {...(sel() ? { backgroundColor: tokens.cursorLine } : {})}>
                  {/* Selection accent is `marker.select` — the dedicated selection
                      token, the SAME hue as the filter `Cursor` block — so one
                      overlay never mixes two accents (agy uses a single accent for
                      cursor + selection). */}
                  <text fg={sel() ? tokens.marker.select : tokens.text.muted}>
                    {`${marker(row.idx, row.pos)} `}
                  </text>
                  <text fg={sel() ? tokens.text.default : tokens.text.muted} wrapMode="none" flexGrow={1}>
                    {truncate(row.opt.label, budget())}
                  </text>
                  {/* The trailing tag rides the row's own colour: selection accent
                      on the active/selected row, dim otherwise (agy keeps the tag
                      in-row). */}
                  <Show when={tagText() !== undefined}>
                    <text fg={sel() || row.opt.active === true ? tokens.marker.select : tokens.text.dim}>
                      {` ${glyph.activeTag} ${tagText()}`}
                    </text>
                  </Show>
                </box>
              </>
            )
          }}
        </For>
      </Show>

      <box height={1} />
      <box flexDirection="row">
        <KeyHints hints={props.footer} grow />
        {/* The `i/N` counter is meaningful for flat lists (models/themes); in a
            grouped manager it would count action/separator rows, so it's hidden. */}
        <Show when={!grouped()}>
          <text fg={tokens.text.muted}>{n() === 0 ? "0/0" : `${s().selected + 1}/${n()}`}</text>
        </Show>
      </box>
    </box>
  )
}
