import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, For, Show } from "solid-js"
import {
  type TreeConversationDisplay,
  type TreeNodeDisplay,
  type TreeRowData,
} from "../../../presentation/contextTreeView.js"
import { treeRows } from "../../../presentation/sidePane.js"
import { glyph, tokens } from "../../../state/theme.js"
import { foldCaret } from "../../ui/index.js"
import type { TuiContext } from "../../../state/store.js"

type Status = "running" | "ok" | "error"

const statusGlyph = (s: Status): string =>
  s === "ok" ? glyph.ok : s === "error" ? glyph.error : glyph.railDot
const statusColor = (s: Status): string =>
  s === "ok" ? tokens.state.ok : s === "error" ? tokens.state.error : tokens.state.running

/**
 * One navigator row, styled from its structured `display` — the same shape
 * `Context.tsx` uses. Conversation roots (the manual branches) carry a fold
 * caret + label + an `◀ active` tag for the live session; agent nodes lead
 * with the git-graph rail (dim ancestor columns + a `├─`/`└─` connector,
 * branched forks tinted in the side accent so a fork point pops), then a
 * status glyph (✓/✗/● coloured by run state, legible without colour too), the
 * scope folder, dim metadata (provenance edge, non-default seed, files-changed
 * count) and the return summary.
 */
const Row = (props: { row: TreeRowData; active: boolean }) => {
  const d = () => props.row.display
  return (
    <box
      flexDirection="row"
      backgroundColor={props.active ? tokens.cursorLine : tokens.bgNone}
    >
      <Show when={props.row.rail.prefix.length > 0}>
        <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>{props.row.rail.prefix}</text>
      </Show>
      <Show when={props.row.rail.connector.length > 0}>
        <text
          fg={
            d().kind === "node" && (d() as TreeNodeDisplay).edgeKind === "branched"
              ? tokens.accent.side
              : tokens.text.dim
          }
          wrapMode="none"
          flexShrink={0}
        >
          {props.row.rail.connector}
        </text>
      </Show>
      <Show
        when={d().kind === "node"}
        fallback={renderConversation(() => d() as TreeConversationDisplay)}
      >
        {renderNode(() => d() as TreeNodeDisplay)}
      </Show>
    </box>
  )
}

const renderConversation = (d: () => TreeConversationDisplay) => {
  const v = d()
  return (
    <>
      <text fg={tokens.text.muted} wrapMode="none" flexShrink={0}>{`${v.hasChildren ? foldCaret(v.folded) : " "} `}</text>
      <text fg={v.active ? tokens.text.default : tokens.text.muted} wrapMode="none">
        {v.label}
      </text>
      <Show when={v.active}>
        <text fg={tokens.accent.side} wrapMode="none" flexShrink={0}>{`  ${glyph.activeTag} active`}</text>
      </Show>
      <Show when={v.nodeCount > 0}>
        <text fg={tokens.text.dim} wrapMode="none">{`  · ${v.nodeCount} agent${v.nodeCount === 1 ? "" : "s"}`}</text>
      </Show>
    </>
  )
}

const renderNode = (d: () => TreeNodeDisplay) => {
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
      <text fg={tokens.text.muted} wrapMode="none" flexShrink={0}>{`${v.hasChildren ? foldCaret(v.folded) : " "} `}</text>
      <text fg={statusColor(v.status)} wrapMode="none" flexShrink={0}>{`${statusGlyph(v.status)} `}</text>
      <text fg={tokens.text.default} wrapMode="none" flexShrink={0}>
        {v.label}
      </text>
      {/* A titled row keeps its scope visible, dim: `audit state layer (tui-solid)`. */}
      <Show when={v.label !== v.folder}>
        <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>{` (${v.folder})`}</text>
      </Show>
      <Show when={v.active}>
        <text fg={tokens.accent.side} wrapMode="none" flexShrink={0}>{`  ${glyph.activeTag} active`}</text>
      </Show>
      <Show when={meta.length > 0}>
        <text fg={tokens.text.dim} wrapMode="none">{`  ${meta}`}</text>
      </Show>
      <Show when={v.stale}>
        <text fg={tokens.state.running} wrapMode="none" flexShrink={0}>{"  stale"}</text>
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
  // Owns the cursor only when the side pane is focused AND the agents view
  // holds the keys (in the split layout activity may hold them).
  const focused = () => store.focus() === "side" && store.sidePane().view === "tree"
  // The SHARED flatten (root-agent anchor + this session's nodes) — must match
  // the keymap's `treeRows` exactly or the cursor and the pixels disagree
  // (the active-node id is display-only, so the keymap omitting it is fine).
  const rows = () => treeRows(sp(), sp(), store.nodePreview()?.nodeId)
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
        fallback={<text fg={tokens.text.dim}>(no sessions yet — chat to start one; run_agent spawns agent branches)</text>}
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
