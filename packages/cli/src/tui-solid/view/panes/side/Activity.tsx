import { homedir } from "node:os"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, For, on, Show } from "solid-js"
import { formatTokens, gaugeBar } from "../../../presentation/statusBar.js"
import type { NodeStatus, TreeNode } from "../../../presentation/executionTree.js"
import {
  buildStackRowsData,
  type StackRowData,
  type StackRowDisplay,
} from "../../../presentation/sidePane.js"
import { clampCursor } from "../../../presentation/paneNav.js"
import { glyph, tokens } from "../../../state/theme.js"
import { SectionHead, foldCaret } from "../../ui/index.js"
import type { TuiContext } from "../../../state/store.js"

const fmtDur = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s - m * 60)}s`
}

const home = (() => {
  try {
    return homedir()
  } catch {
    return ""
  }
})()
const prettyPath = (p: string): string =>
  home !== "" && p.startsWith(home) ? `~${p.slice(home.length)}` : p

const statusColor = (status: NodeStatus): string =>
  status === "running" ? tokens.state.running : status === "error" ? tokens.state.error : tokens.state.ok

/** The Activity stats header: a context gauge + a cumulative one-liner. */
const Stats = (props: { ctx: TuiContext }) => {
  const s = () => props.ctx.store.sidePane().stats
  const win = () => (s().contextWindow > 0 ? formatTokens(s().contextWindow) : "?")
  const elapsed = () => (s().startedAt > 0 ? fmtDur(Date.now() - s().startedAt) : "0s")
  const ran = () => s().turns > 0 || s().outputTokens > 0
  // `~` marks a resume estimate (chars/4 over the loaded history) until the
  // first real provider count replaces it — a precise-looking wrong number
  // is worse than an approximate honest one.
  const approx = () => (s().estimated === true ? "~" : "")
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={tokens.text.muted}>
        {`ctx ${gaugeBar(s().inputTokens, s().contextWindow, 8)} ${approx()}${formatTokens(s().inputTokens)}/${win()} (${formatTokens(s().cacheReadTokens)} cached)`}
      </text>
      {/* A wall of zeros tells a new user nothing — say what WILL be here. */}
      <text fg={tokens.text.dim}>
        {ran()
          ? `${formatTokens(s().outputTokens)} tok out · ${s().turns} turn${s().turns === 1 ? "" : "s"} · ${elapsed()}`
          : "no run yet — send a message to start"}
      </text>
    </box>
  )
}

/**
 * The agent's working plan — the latest `update_plan` checklist, pinned under
 * the stats header (not part of the navigable rows, like the gauge). Statuses
 * reuse the terminal glyph vocabulary: ✓ done · ● active (running colour) ·
 * ○ pending (dim). Hidden until the agent first plans.
 */
const Plan = (props: { ctx: TuiContext }) => {
  const plan = () => props.ctx.store.projection().plan
  return (
    <Show when={plan().length > 0}>
      <box flexDirection="column" flexShrink={0} marginTop={1}>
        <For each={plan()}>
          {(s) => (
            <box flexDirection="row">
              <text
                fg={
                  s.status === "done"
                    ? tokens.state.ok
                    : s.status === "active"
                      ? tokens.state.running
                      : tokens.text.dim
                }
                wrapMode="none"
                flexShrink={0}
              >
                {`${s.status === "done" ? glyph.ok : s.status === "active" ? glyph.railDot : glyph.select.off} `}
              </text>
              <text
                fg={s.status === "active" ? tokens.text.default : tokens.text.muted}
                wrapMode="word"
                flexShrink={1}
              >
                {s.step}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

/** One execution-tree node's own line (its children are sibling rows). The glyph
 *  + duration are live (spinner frame, elapsed), so they're computed here, not in
 *  the pure row. */
const NodeRow = (props: { node: TreeNode; folded: boolean; spinner: number }) => {
  const n = props.node
  const isContainer = n.kind === "run" || n.kind === "turn" || n.kind === "subagent"
  const nodeGlyph = () => {
    if (isContainer) return foldCaret(props.folded)
    if (n.status === "running") return glyph.spinner[props.spinner % glyph.spinner.length]
    return n.status === "error" ? glyph.error : glyph.ok
  }
  const glyphColor = () =>
    isContainer
      ? n.status === "running"
        ? tokens.state.running
        : n.status === "error"
          ? tokens.state.error
          : tokens.text.muted
      : statusColor(n.status)
  const suffix = () => {
    const unit = n.kind === "run" ? "turn" : "tool"
    const count =
      props.folded && n.children.length > 0
        ? ` · ${n.children.length} ${unit}${n.children.length === 1 ? "" : "s"}`
        : ""
    const detail = n.detail !== undefined ? ` ${n.detail}` : ""
    // A tree rebuilt from persisted messages has no timestamps (all 0) —
    // endedAt === startedAt means "duration unknown", not "0ms".
    const dur =
      isContainer && n.endedAt !== n.startedAt
        ? ` ${fmtDur((n.endedAt ?? Date.now()) - n.startedAt)}`
        : ""
    return `${count}${detail}${dur}`
  }
  // flexShrink=0 everywhere: an overflowing row must CLIP at the pane edge,
  // not let Yoga shrink each text (which eats the glyph's space and the
  // label's tail before the detail — `✗Write(poem.txtpoem.txt is outside…`).
  return (
    <>
      <text fg={glyphColor()} flexShrink={0}>{`${nodeGlyph()} `}</text>
      {/* A run root IS the user's message — same quiet prompt styling as the
          conversation rail, so the two panes read as one vocabulary. */}
      <Show when={n.kind === "run"}>
        <text fg={tokens.text.dim} flexShrink={0}>{`${glyph.msg.user} `}</text>
      </Show>
      <text
        fg={n.kind === "run" ? tokens.text.user : tokens.text.default}
        wrapMode="none"
        flexShrink={0}
      >
        {n.label}
      </text>
      <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>{suffix()}</text>
    </>
  )
}

/** Inner content for one Activity row, by display kind. The wrapping box (indent
 *  + cursor tint + id) is applied by the caller. */
const StackRowView = (props: { display: StackRowDisplay; spinner: number }) => {
  const d = props.display
  switch (d.kind) {
    case "node":
      return <NodeRow node={d.node} folded={d.folded} spinner={props.spinner} />
    case "section":
      return (
        <SectionHead label={d.label} count={d.count} collapsed={d.folded} summary={d.summary} />
      )
    case "file":
      return (
        <>
          <text fg={tokens.text.muted}>{`${prettyPath(d.file.path)} `}</text>
          <text fg={tokens.state.ok}>{`+${d.file.added}`}</text>
          <text fg={tokens.text.dim}>/</text>
          <text fg={tokens.state.error}>{`-${d.file.removed}`}</text>
        </>
      )
    case "skill":
      return <text fg={tokens.text.muted}>{`· ${d.name}`}</text>
    case "instruction":
      return <text fg={tokens.text.muted}>{`· ${prettyPath(d.path)}`}</text>
  }
}

/** Left indent (cells) for a row — matches the old tree depth + section nesting. */
const indentOf = (row: StackRowData): number => {
  switch (row.display.kind) {
    case "node":
      return row.depth * 2
    case "section":
      return 0
    default:
      return 3
  }
}

/**
 * The side pane's Activity view: a pinned stats header, then the live execution
 * tree + the foldable files/skills/instructions sections flattened into one
 * navigable row list (`buildStackRowsData`) so the block cursor maps 1:1 to the
 * rendered line — the same shape `Context.tsx` uses. `j/k`·`{}` step rows, `[]`
 * jumps heads, `⇥/↵` fold the row under the cursor (driven in `keys/dispatch`).
 * The focused cursor row gets the `cursorLine` tint and is scrolled into view.
 */
export const Activity = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  // Owns the cursor only when the side pane is focused AND the activity view
  // holds the keys (in the split layout the agents tree may hold them).
  const focused = () => store.focus() === "side" && store.sidePane().view === "stack"
  const rows = () => buildStackRowsData(store.projection(), store.nav().stackCollapsed)
  const cursor = () => clampCursor(rows().length, store.nav().stackCursor)
  // The row list is ordered tree-then-sections; the tree scrolls, the
  // workspace sections (files/skills/instructions) pin at the pane bottom.
  // Both halves keep their GLOBAL row index so the cursor maps 1:1.
  const splitAt = () => {
    const r = rows()
    const i = r.findIndex((row) => row.display.kind !== "node")
    return i === -1 ? r.length : i
  }
  const treeRowsPart = () => rows().slice(0, splitAt())
  const sectionRowsPart = () => rows().slice(splitAt())

  let sb!: ScrollBoxRenderable
  // Scroll the cursor into view ONLY when it actually moves (not on every tree
  // append) — otherwise a streaming run would yank the view back to a stale
  // cursor and strand the freshly-added bottom nodes. Sticky-bottom owns "follow
  // new content"; the cursor owns "jump on keypress". Section rows live outside
  // the scrollbox (always visible), so only tree rows scroll in.
  createEffect(
    on(
      () => store.nav().stackCursor,
      () => {
        if (focused() && sb && cursor() < splitAt()) sb.scrollChildIntoView(`stk-row-${cursor()}`)
      },
    ),
  )

  const rowBox = (row: StackRowData, i: number) => (
    <box
      id={`stk-row-${i}`}
      flexDirection="row"
      marginLeft={indentOf(row)}
      backgroundColor={focused() && i === cursor() ? tokens.cursorLine : tokens.bgNone}
    >
      <StackRowView display={row.display} spinner={store.spinner()} />
    </box>
  )

  return (
    <>
      {/* Stats header is pinned above the scroll region so it stays visible. */}
      <Stats ctx={props.ctx} />
      <Plan ctx={props.ctx} />
      <text flexShrink={0}> </text>
      <scrollbox
        ref={sb}
        stickyScroll
        stickyStart="bottom"
        scrollY
        flexGrow={1}
        flexDirection="column"
        verticalScrollbarOptions={{ visible: false }}
      >
        <Show when={store.projection().tree.roots.length === 0}>
          <text fg={tokens.text.dim}>(idle)</text>
        </Show>
        <For each={treeRowsPart()}>{(row, i) => rowBox(row, i())}</For>
      </scrollbox>
      {/* Workspace sections pinned under the run tree, behind a rule — capped
          so an expanded file list can't squeeze the live tree out. */}
      <box flexDirection="column" flexShrink={0} maxHeight="45%" overflow="hidden" marginTop={1}>
        <text fg={tokens.text.dim} flexShrink={0}>{`${glyph.seedRule} workspace ${glyph.seedRule}`}</text>
        <For each={sectionRowsPart()}>{(row, i) => rowBox(row, splitAt() + i())}</For>
      </box>
    </>
  )
}
