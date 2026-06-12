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
  <text fg={tokens.text.dim}>{"─".repeat(props.width)}</text>
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
