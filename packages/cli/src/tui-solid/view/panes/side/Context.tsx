import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, For, Show } from "solid-js"
import {
  buildContextRowsData,
  type ContextRowData,
  type ContextRowDisplay,
} from "../../../presentation/contextView.js"
import { glyph, tokens } from "../../../state/theme.js"
import { Marker, foldCaret } from "../../ui/index.js"
import type { TuiContext } from "../../../state/store.js"

/**
 * One context row, styled from its structured `display` payload — the OpenTUI
 * analogue of `renderContextView`'s ANSI line. Each kind composes coloured
 * `<text>` segments in a row; the focused-cursor row gets a background tint (the
 * old hardware block cursor's `bgCursorLine`). `depth` drives the left indent.
 */
const Row = (props: { row: ContextRowData; active: boolean }) => {
  const d = (): ContextRowDisplay => props.row.display
  const indent = () => props.row.depth * 2

  // backgroundColor has no `undefined` member under exactOptionalPropertyTypes,
  // so the cursor tint is a conditional spread rather than `bg() | undefined`.
  return (
    <box
      flexDirection="row"
      marginLeft={indent()}
      backgroundColor={props.active ? tokens.cursorLine : tokens.bgNone}
    >
      {renderSegments(d)}
    </box>
  )
}

const renderSegments = (d: () => ContextRowDisplay) => {
  const v = d()
  switch (v.kind) {
    case "header":
      return (
        <text fg={tokens.text.muted} wrapMode="none">
          {`── context ── ` +
            (v.hasFold
              ? `loaded ${v.loaded}${v.hasSummary ? ` + ${glyph.summary}` : ""} · archived ${v.archived}`
              : `${v.loaded} msg${v.loaded === 1 ? "" : "s"} · no handoff yet`) +
            (v.selectedCount > 0 ? ` · ${v.selectedCount} selected` : "")}
        </text>
      )
    case "segment":
      return v.archived ? (
        <>
          <text fg={tokens.text.muted}>{`${foldCaret(v.folded)} `}</text>
          <Marker on={v.selected} />
          <text fg={tokens.marker.handoff}>{`${glyph.handoff} `}</text>
          <text fg={tokens.text.dim} wrapMode="none">
            {`handoff #${v.handoffIndex} · summary + ${v.foldedCount} msg${v.foldedCount === 1 ? "" : "s"} folded`}
          </text>
        </>
      ) : (
        <>
          <text fg={tokens.text.muted}>{`${foldCaret(v.folded)} `}</text>
          <text fg={tokens.marker.loaded}>{`${glyph.loaded} `}</text>
          <text fg={tokens.text.default}>loaded context</text>
        </>
      )
    case "summary":
      return (
        <>
          <text fg={tokens.marker.handoff}>{`${glyph.summary} `}</text>
          <text fg={tokens.text.dim} wrapMode="none">
            {v.text}
          </text>
        </>
      )
    case "turn":
      return (
        <>
          <text fg={tokens.text.muted}>{`${foldCaret(v.folded)} `}</text>
          <Marker on={v.selected} />
          <text fg={v.archived ? tokens.text.dim : tokens.text.default} wrapMode="none">
            {v.subject}
          </text>
          <text fg={tokens.text.dim}>{`  · ${v.steps}`}</text>
        </>
      )
    case "message":
      return (
        <text fg={tokens.text.dim} wrapMode="none">
          {`${v.icon} ${v.text}`}
        </text>
      )
  }
}

/**
 * The context viewer: a navigable tree of foldable, selectable turns + handoff
 * segments. Reuses the pure `buildContextRowsData` walk (so the cursor index
 * matches the `sidePane.ts` reducers exactly) and the `SidePaneState` cursor /
 * fold / selection sets. The scrollbox is unfocused (cursor nav is keyboard-
 * driven in `keymap.ts`); an effect keeps the cursor row scrolled into view.
 */
export const ContextView = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const sp = () => store.sidePane()
  const focused = () => store.focus() === "side"
  const rows = () =>
    buildContextRowsData(
      sp().context ?? [],
      sp().contextCollapsed,
      sp().contextSelected,
      sp().contextHandoffSelected,
    )
  const cursor = () => sp().contextCursor

  // Solid assigns the ref during render (before effects run); `!` keeps the prop
  // type clean under exactOptionalPropertyTypes.
  let sb!: ScrollBoxRenderable
  createEffect(() => {
    const i = cursor()
    if (sb) sb.scrollChildIntoView(`ctx-row-${i}`)
  })

  return (
    <scrollbox
      ref={sb}
      scrollY
      flexGrow={1}
      flexDirection="column"
      verticalScrollbarOptions={{ visible: false }}
    >
      <Show
        when={rows().length > 0}
        fallback={<text fg={tokens.text.dim}>(no conversation yet)</text>}
      >
        <For each={rows()}>
          {(row, i) => (
            <box id={`ctx-row-${i()}`}>
              <Row row={row} active={focused() && i() === cursor()} />
            </box>
          )}
        </For>
      </Show>
    </scrollbox>
  )
}
