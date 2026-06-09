import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, For, Show } from "solid-js"
import {
  buildTreeRowsData,
  type TreeRowData,
  type TreeRowDisplay,
} from "../../../presentation/contextTreeView.js"
import { glyph, tokens } from "../../../state/theme.js"
import { foldCaret } from "../../ui/index.js"
import type { TuiContext } from "../../../state/store.js"

type Status = "running" | "ok" | "error"

const statusGlyph = (s: Status): string =>
  s === "ok" ? glyph.ok : s === "error" ? glyph.error : glyph.railDot
const statusColor = (s: Status): string =>
  s === "ok" ? tokens.state.ok : s === "error" ? tokens.state.error : tokens.state.running

/**
 * One context-tree row, styled from its structured `display` — the same shape
 * `Context.tsx` uses. A status glyph (✓/✗/● coloured by run state, legible
 * without colour too), the scope folder, then dim metadata (provenance edge,
 * non-default seed, files-changed count) and the return summary.
 */
const Row = (props: { row: TreeRowData; active: boolean }) => {
  const d = (): TreeRowDisplay => props.row.display
  const indent = () => props.row.depth * 2
  return (
    <box
      flexDirection="row"
      marginLeft={indent()}
      {...(props.active ? { backgroundColor: tokens.cursorLine } : {})}
    >
      {renderNode(d)}
    </box>
  )
}

const renderNode = (d: () => TreeRowDisplay) => {
  const v = d()
  const meta = [
    v.edgeKind !== "spawned" ? v.edgeKind : undefined,
    v.seedKind !== "task" ? `seed:${v.seedKind}` : undefined,
    v.filesCount > 0 ? `${v.filesCount}f` : undefined,
    v.tokens,
  ]
    .filter((x): x is string => x !== undefined)
    .join(" · ")
  return (
    <>
      <text fg={tokens.text.muted}>{`${v.hasChildren ? foldCaret(v.folded) : " "} `}</text>
      <text fg={statusColor(v.status)}>{`${statusGlyph(v.status)} `}</text>
      <text fg={tokens.text.default} wrapMode="none">
        {v.folder}
      </text>
      <Show when={meta.length > 0}>
        <text fg={tokens.text.dim}>{`  ${meta}`}</text>
      </Show>
      <Show when={v.summary !== undefined && v.summary.length > 0}>
        <text fg={tokens.text.dim} wrapMode="none">{`  — ${v.summary}`}</text>
      </Show>
    </>
  )
}

/**
 * The context-tree viewer (`:tree`): a navigable, foldable tree of the
 * sub-agents spawned/branched/resumed in this conversation, reconstructed from
 * the persisted `ContextTreeStore`. Reuses the pure `buildTreeRowsData` walk (so
 * the cursor index matches the `sidePane.ts` reducers) + the `SidePaneState`
 * cursor/fold sets; an effect keeps the cursor row scrolled into view.
 */
export const ContextTreeView = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const sp = () => store.sidePane()
  const focused = () => store.focus() === "side"
  const rows = () => buildTreeRowsData(sp().treeNodes ?? [], sp().treeCollapsed)
  const cursor = () => sp().treeCursor

  let sb!: ScrollBoxRenderable
  createEffect(() => {
    const i = cursor()
    if (sb) sb.scrollChildIntoView(`tree-row-${i}`)
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
        fallback={<text fg={tokens.text.dim}>(no sub-agents yet — run_agent spawns them)</text>}
      >
        <For each={rows()}>
          {(row, i) => (
            <box id={`tree-row-${i()}`}>
              <Row row={row} active={focused() && i() === cursor()} />
            </box>
          )}
        </For>
      </Show>
    </scrollbox>
  )
}
