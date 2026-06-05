import { Show } from "solid-js"
import { glyph, tokens } from "../../state/theme.js"

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
 * One event-rail line: a coloured `●` dot followed by content text. OpenTUI
 * `<span>` carries no colour, so the dot and content are two `<text>`s in a row;
 * the content grows + wraps so prose flows within the pane width. `dot` is the
 * dot's colour (the glyph itself is fixed).
 */
export const RailLine = (props: { dot: string; fg: string; text: string; wrap?: boolean }) => (
  <box flexDirection="row">
    <text fg={props.dot}>{`${glyph.railDot} `}</text>
    <text fg={props.fg} flexGrow={1} wrapMode={props.wrap ? "word" : "none"}>
      {props.text}
    </text>
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
