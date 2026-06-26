import { createMemo, Show } from "solid-js"
import { splitByMatch } from "../../presentation/conversation.js"
import { glyph, tokens } from "../../state/theme.js"

/** What the word-level search highlight needs to know at a text site: the
 *  active query and whether this row is the current `[i/N]` match. */
export interface Hl {
  readonly query: string
  readonly current: boolean
}

/**
 * Plain text with the active `/`-search query highlighted WORD-level: every
 * case-insensitive occurrence renders as a chip (`tokens.match.word`, the
 * brighter `wordCurrent` on the current match row) — vim hlsearch, not just a
 * row tint. No `hl` (or no occurrence) → an ordinary `<text>`. Only for plain
 * text sites; markdown/diff content can't splice spans.
 */
export const HlText = (props: {
  text: string
  fg: string
  hl?: Hl | undefined
  wrap?: boolean
  grow?: boolean
  shrink?: boolean
}) => {
  const segs = createMemo(() => splitByMatch(props.text, props.hl?.query ?? ""))
  const chip = () => (props.hl?.current === true ? tokens.match.wordCurrent : tokens.match.word)
  return (
    <text
      fg={props.fg}
      wrapMode={props.wrap === false ? "none" : "word"}
      flexGrow={props.grow === true ? 1 : 0}
      flexShrink={props.shrink === false ? 0 : 1}
    >
      {segs().map((s) =>
        // Span colours ride the `style` prop — the binding's setProperty maps
        // style.fg/bg onto the TextNodeRenderable (direct props aren't typed).
        s.match ? <span style={{ fg: chip().fg, bg: chip().bg }}>{s.text}</span> : s.text,
      )}
    </text>
  )
}

/** A horizontal divider rule of `width` cells (dim `─`). */
export const Rule = (props: { width: number }) => (
  <text fg={tokens.text.dim}>{glyph.rule.repeat(props.width)}</text>
)

/** One key→label pair for {@link KeyHints} (e.g. `{ key: "↑/↓", label: "navigate" }`). */
export interface KeyHint {
  readonly key: string
  readonly label: string
}

/**
 * A footer hint row, agy-style: each binding renders as an **accent key chip**
 * followed by a **dim label**, pairs separated by a dim `·`. One source of truth
 * for the key/label colour pairing so every overlay footer reads identically.
 * `grow` lets it fill the row (pushing a trailing counter to the right edge).
 */
export const KeyHints = (props: { hints: ReadonlyArray<KeyHint>; grow?: boolean }) => (
  <box flexDirection="row" flexGrow={props.grow === true ? 1 : 0} flexShrink={1}>
    {props.hints.map((h, i) => (
      <>
        {i > 0 ? <text fg={tokens.text.dim}>{" · "}</text> : null}
        <text fg={tokens.marker.select} wrapMode="none">{h.key}</text>
        <text fg={tokens.text.dim} wrapMode="none">{` ${h.label}`}</text>
      </>
    ))}
  </box>
)

/** Truncate a label to fit `max` cells (… elision). Shared by every menu row. */
export const truncate = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`

/**
 * One selectable menu row — the single source for a list/menu/picker row across
 * the whole app (the `:` command menu and every `SelectBody` list/manager). A
 * leading marker glyph in the selection accent, the label, an optional dim
 * description column (agy contextual-menu look), and an optional trailing
 * `◀ tag`. Change the caret, the selection colour, or the row shape HERE and
 * every menu in the app follows.
 */
export const MenuRow = (props: {
  selected: boolean
  /** Leading marker — the pointer when selected, or a scroll arrow / blank. */
  marker: string
  label: string
  labelBudget: number
  desc?: string | undefined
  tag?: string | undefined
  /** Tint the tag with the selection accent even when the row isn't selected. */
  tagActive?: boolean | undefined
}) => (
  <box flexDirection="row" {...(props.selected ? { backgroundColor: tokens.cursorLine } : {})}>
    {/* Selection accent is `marker.select` — the same hue as the filter cursor —
        so one menu never mixes two accents (agy uses a single accent throughout). */}
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

/** The block text cursor (`█`) shown in text-entry overlays/filters. */
export const Cursor = () => <text fg={tokens.marker.cursor}>{glyph.cursorBlock}</text>

/** A `◉`/`○` multi-select marker (context viewer pick), trailing space included. */
export const Marker = (props: { on: boolean }) => (
  <text fg={props.on ? tokens.marker.select : tokens.text.dim}>
    {props.on ? `${glyph.select.on} ` : `${glyph.select.off} `}
  </text>
)

/** The fold caret for a row — `▾` when expanded, `▸` when collapsed. */
export const foldCaret = (collapsed: boolean): string =>
  collapsed ? glyph.fold.closed : glyph.fold.open

/**
 * One event-rail line: a coloured `●` dot followed by content text (an
 * {@link HlText}, so an active search highlights matched words in it); the
 * content grows + wraps so prose flows within the pane width. `dot` is the
 * dot's colour (the glyph itself is fixed).
 */
export const RailLine = (props: {
  dot: string
  fg: string
  text: string
  wrap?: boolean
  hl?: Hl | undefined
}) => (
  <box flexDirection="row">
    <text fg={props.dot}>{`${glyph.railDot} `}</text>
    <HlText text={props.text} fg={props.fg} hl={props.hl} grow wrap={props.wrap === true} />
  </box>
)

/**
 * A foldable section header: `▸/▾ label (count)` with an optional trailing
 * summary. Shared by the Activity dashboard's files/skills/instructions sections.
 */
export const SectionHead = (props: {
  label: string
  count: number
  collapsed: boolean
  summary?: string | undefined
}) => (
  <box flexDirection="row">
    <text fg={tokens.text.muted}>{`${foldCaret(props.collapsed)} ${props.label} `}</text>
    <text fg={tokens.text.dim}>{`(${props.count})`}</text>
    <Show when={props.summary}>
      <text fg={tokens.text.muted}>{props.summary}</text>
    </Show>
  </box>
)
