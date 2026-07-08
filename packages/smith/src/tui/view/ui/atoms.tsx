import { Show } from "solid-js"
import { glyph, tokens } from "../../theme.js"

/** Truncate a label to fit `max` cells (… elision). Shared by every menu row. */
export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

/** One key→label pair for {@link KeyHints}. */
export interface KeyHint {
  readonly key: string
  readonly label: string
}

/**
 * A footer hint row: each binding renders as an accent key chip followed by
 * a dim label, pairs separated by a dim `·`. One source of truth for the
 * key/label colour pairing so every overlay footer reads identically.
 */
export const KeyHints = (props: { hints: ReadonlyArray<KeyHint> }) => (
  <box flexDirection="row" flexShrink={1}>
    {props.hints.map((h, i) => (
      <>
        {i > 0 ? <text fg={tokens.text.dim}>{" · "}</text> : null}
        <text fg={tokens.marker.select} wrapMode="none">{h.key}</text>
        <text fg={tokens.text.dim} wrapMode="none">{` ${h.label}`}</text>
      </>
    ))}
  </box>
)

/**
 * One selectable menu row — the single source for every list/picker row: a
 * leading marker in the selection accent, the label, an optional dim
 * description column, and an optional trailing `◀ tag`. Change the caret,
 * the selection colour, or the row shape HERE and every menu follows.
 */
export const MenuRow = (props: {
  selected: boolean
  marker: string
  label: string
  labelBudget: number
  desc?: string | undefined
  tag?: string | undefined
  tagActive?: boolean | undefined
}) => (
  <box flexDirection="row" {...(props.selected ? { backgroundColor: tokens.cursorLine } : {})}>
    <text fg={props.selected ? tokens.marker.select : tokens.text.muted}>
      {`${props.marker} `}
    </text>
    <text
      fg={props.selected ? tokens.text.default : tokens.text.muted}
      wrapMode="none"
      flexGrow={props.desc === undefined ? 1 : 0}
    >
      {truncate(props.label, props.labelBudget)}
    </text>
    <Show when={props.desc !== undefined}>
      <text fg={tokens.text.muted} wrapMode="none" flexGrow={1}>{`  ${props.desc}`}</text>
    </Show>
    <Show when={props.tag !== undefined}>
      <text fg={props.selected || props.tagActive === true ? tokens.marker.select : tokens.text.dim}>
        {` ${glyph.activeTag} ${props.tag}`}
      </text>
    </Show>
  </box>
)
