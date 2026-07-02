import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, For, Show } from "solid-js"
import {
  reconcileTreeRows,
  type TreeConversationDisplay,
  type TreeNodeDisplay,
  type TreeRowData,
} from "../../../presentation/contextTreeView.js"
import { emptyProjection, treeRows, type SidePaneState } from "../../../presentation/sidePane.js"
import { glyph, tokens } from "../../../state/theme.js"
import { foldCaret } from "../../ui/index.js"
import type { TuiContext } from "../../../state/store.js"

type Status = "running" | "ok" | "partial" | "error" | "killed"

// `partial` = a usable deliverable that stopped early (half-moon, attention
// tint); `killed` = interrupted / stalled empty (reads as a failure).
const statusGlyph = (s: Status): string =>
  s === "ok"
    ? glyph.ok
    : s === "partial"
      ? glyph.partial
      : s === "error" || s === "killed"
        ? glyph.error
        : glyph.railDot
const statusColor = (s: Status): string =>
  s === "ok"
    ? tokens.state.ok
    : s === "partial"
      ? tokens.state.running
      : s === "error" || s === "killed"
        ? tokens.state.error
        : tokens.state.running

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
const Row = (props: { row: TreeRowData; active: boolean; store: TuiContext["store"] }) => {
  const d = () => props.row.display
  // A row carries a fold caret iff it is foldable (has a `foldId`); the lone
  // always-expanded session root has none, so it shows no caret.
  const foldable = () => props.row.foldId !== undefined
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
        fallback={renderConversation({ d: () => d() as TreeConversationDisplay, foldable: foldable(), store: props.store })}
      >
        {renderNode({ d: () => d() as TreeNodeDisplay, foldable: foldable(), store: props.store })}
      </Show>
    </box>
  )
}

const renderConversation = (props: { d: () => TreeConversationDisplay; foldable: boolean; store: TuiContext["store"] }) => {
  const v = props.d()
  const spin = () =>
    v.rootRunning
      ? glyph.spinner[props.store.spinner() % glyph.spinner.length]
      : glyph.railDot
  return (
    <>
      <text fg={tokens.text.muted} wrapMode="none" flexShrink={0}>{`${props.foldable ? foldCaret(v.folded) : " "} `}</text>
      {/* The orchestrator's own live status: a running spinner while its turn is
          in flight (next to the fleet's per-agent glyphs), a dim ● when idle. */}
      <text
        fg={v.rootRunning ? tokens.state.running : tokens.text.dim}
        wrapMode="none"
        flexShrink={0}
      >{`${spin()} `}</text>
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

const renderNode = (props: { d: () => TreeNodeDisplay; foldable: boolean; store: TuiContext["store"] }) => {
  const v = props.d()
  const spin = () =>
    v.status === "running"
      ? glyph.spinner[props.store.spinner() % glyph.spinner.length]
      : statusGlyph(v.status)
  const meta = [
    // The fleet tier (a top-level task/coordinator) reads distinctly from a
    // worker agent; the agent tier is the unmarked default, so only tag fleets.
    v.tier === "fleet" ? "fleet" : undefined,
    v.edgeKind !== "spawned" ? v.edgeKind : undefined,
    v.seedKind !== "task" ? `seed:${v.seedKind}` : undefined,
    v.filesCount > 0 ? `${v.filesCount}f` : undefined,
    v.tokens,
  ]
    .filter((x): x is string => x !== undefined)
    .join(" · ")
  return (
    <>
      <text fg={tokens.text.muted} wrapMode="none" flexShrink={0}>{`${props.foldable ? foldCaret(v.folded) : " "} `}</text>
      <text fg={statusColor(v.status)} wrapMode="none" flexShrink={0}>{`${spin()} `}</text>
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
  // Owns the cursor only when the fleet-tree pane is focused.
  const focused = () => store.focus() === "tree"
  // The orchestrator's own turn is "running" whenever the agent phase isn't
  // idle — gate on the PHASE machine, not `store.busy()`, which is only set on
  // the in-process bin (so a `busy()` source froze the lead's live glyph on the
  // remote/daemon bin). MEMOISED so it only notifies on the idle↔active FLIP
  // (once per turn), not on every agent event — otherwise the rows memo below
  // would re-run per event just to re-read a boolean that didn't change.
  const rootRunning = createMemo(() => store.agentState().phase !== "idle")
  // The fleet tree's inputs are ONLY the fleet data + nav (cursor/folds). Read
  // the NARROW signals (`treeData()` + `nav()`), NOT the merged `sidePane()`:
  // `sidePane`/`projection` change on EVERY execution-tree event, but the fleet
  // doesn't — so reading them would re-derive the whole pane per tool call. With
  // the narrow reads, this memo re-runs only when the fleet, the cursor/folds,
  // or the root-running flip actually change. `emptyProjection` supplies the
  // inert tree/stats fields the pure `treeRows` ignores (const → no subscription).
  const treeState = createMemo<SidePaneState>(() => ({
    ...emptyProjection,
    ...store.treeData(),
    ...store.nav(),
  }))
  // Memoised + reconciled: a real fleet change re-renders only the rows that
  // actually changed; an unchanged rebuild returns the SAME array reference, so
  // the `<For>` does nothing. Mirrors the conversation rail's `reconcileItems`.
  const rows = createMemo<ReadonlyArray<TreeRowData>>(
    (prev) =>
      reconcileTreeRows(
        prev,
        treeRows(treeState(), treeState(), store.nodePreview()?.nodeId, rootRunning()),
      ),
    [],
  )
  const cursor = () => store.nav().treeCursor

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
              <Row row={row} active={focused() && i() === cursor()} store={store} />
            </box>
          )}
        </For>
      </Show>
    </scrollbox>
  )
}
