import { basename } from "node:path"
import { createMemo, For, Show } from "solid-js"
import type { AgentContextNode } from "@xandreed/sdk-core"
import { findByNodeId, type TreeNode } from "../../../presentation/executionTree.js"
import { treeCurrentRow } from "../../../presentation/sidePane.js"
import { formatTokens } from "../../../presentation/statusBar.js"
import { glyph, tokens } from "../../../state/theme.js"
import type { TuiContext } from "../../../state/store.js"

/**
 * The navigator's **detail section** (below the tree in the side pane's
 * agents view): a live mirror of whatever the tree cursor is on. A node row
 * shows the node's full record — status, provenance, seed, billed tokens, the
 * UNCLIPPED return summary, files changed — plus, while the node is running,
 * its live tool feed (the keyed Activity container). A conversation row shows
 * the session's identity and how to act on it. Pure derivation from the nav
 * cursor + projection, so it reacts to every `j`/`k` in the tree below.
 */

const statusColor = (s: AgentContextNode["status"]): string =>
  s === "ok" ? tokens.state.ok : s === "error" ? tokens.state.error : tokens.state.running
const statusGlyph = (s: AgentContextNode["status"]): string =>
  s === "ok" ? glyph.ok : s === "error" ? glyph.error : glyph.railDot

const NodeView = (props: { ctx: TuiContext; node: AgentContextNode }) => {
  const { store } = props.ctx
  const n = () => props.node
  const billed = () => {
    const u = n().usage
    return u === undefined ? undefined : `${formatTokens(u.inputTokens + u.outputTokens)} tok`
  }
  // The node's LIVE container in the Activity execution tree, while running.
  const live = () => findByNodeId(store.sidePane().tree.roots, n().id)
  const liveTools = () => (live()?.children ?? []).slice(-8)
  return (
    <box flexDirection="column" overflow="hidden">
      <box flexDirection="row" flexShrink={0}>
        <text fg={statusColor(n().status)} wrapMode="none" flexShrink={0}>
          {`${statusGlyph(n().status)} `}
        </text>
        <text fg={tokens.text.default} wrapMode="none" flexShrink={0}>
          {n().title ?? (basename(n().folder) || n().folder)}
        </text>
        <text fg={tokens.text.dim} wrapMode="none">
          {`  ${basename(n().folder) || n().folder} · ${n().edgeKind} · seed:${n().seed.kind}${billed() !== undefined ? ` · ${billed()}` : ""}`}
        </text>
      </box>
      <Show when={n().seed.preview !== undefined}>
        <text fg={tokens.text.muted} wrapMode="word" flexShrink={0}>
          {`${glyph.connector} ${n().seed.preview}`}
        </text>
      </Show>
      <Show when={n().status === "running"}>
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <For each={liveTools()}>
            {(t) => (
              <text
                fg={t.status === "running" ? tokens.state.running : tokens.text.dim}
                wrapMode="none"
              >
                {`  ${t.status === "running" ? glyph.railDot : glyph.ok} ${t.label}${t.detail !== undefined ? `  ${t.detail}` : ""}`}
              </text>
            )}
          </For>
          <Show when={liveTools().length === 0}>
            <text fg={tokens.text.dim}>{"  thinking…"}</text>
          </Show>
        </box>
      </Show>
      <Show when={n().returnSummary !== undefined && n().status !== "running"}>
        <box marginTop={1} flexShrink={1} overflow="hidden">
          <text fg={tokens.text.muted} wrapMode="word">
            {n().returnSummary}
          </text>
        </box>
      </Show>
      <Show when={n().filesChanged.length > 0}>
        <box flexDirection="column" marginTop={1} flexShrink={0}>
          <For each={n().filesChanged.slice(0, 6)}>
            {(f) => (
              <text fg={tokens.text.dim} wrapMode="none">{`  ${glyph.connector} ${f}`}</text>
            )}
          </For>
          <Show when={n().filesChanged.length > 6}>
            <text fg={tokens.text.dim}>{`    … ${n().filesChanged.length - 6} more`}</text>
          </Show>
        </box>
      </Show>
      <text fg={tokens.text.dim} flexShrink={0} wrapMode="none">
        {"↵ open session · c fork · i ask it"}
      </text>
    </box>
  )
}

/** The newest still-running tool anywhere in the live execution tree. */
const runningToolLabel = (roots: ReadonlyArray<TreeNode>): string | undefined => {
  let found: string | undefined
  const walk = (n: TreeNode): void => {
    if (n.kind === "tool" && n.status === "running") found = n.label
    for (const c of n.children) walk(c)
  }
  for (const r of roots) walk(r)
  return found
}

/**
 * Root-agent detail: the live state of the conversation itself — context
 * gauge, turns, files touched, and what it's executing right now. The root is
 * where the cursor starts; this half must say something worth half a pane.
 */
const RootView = (props: { ctx: TuiContext; label: string }) => {
  const { store } = props.ctx
  const sp = () => store.sidePane()
  const stats = () => sp().stats
  const current = () => runningToolLabel(sp().tree.roots)
  return (
    <box flexDirection="column" overflow="hidden">
      <box flexDirection="row" flexShrink={0}>
        <text fg={store.busy() ? tokens.state.running : tokens.state.ok} flexShrink={0}>
          {`${glyph.railDot} `}
        </text>
        <text fg={tokens.text.default} wrapMode="none">
          {props.label}
        </text>
      </box>
      <text fg={tokens.text.dim} wrapMode="none">
        {`  ctx ${formatTokens(stats().inputTokens)}/${formatTokens(stats().contextWindow)} · ${stats().turns} turn${stats().turns === 1 ? "" : "s"} · ${sp().filesChanged.length} file${sp().filesChanged.length === 1 ? "" : "s"}`}
      </text>
      <Show
        when={store.busy()}
        fallback={
          <text fg={tokens.text.dim} wrapMode="none">
            {"  idle · ↵ shows its rail · i to talk to it"}
          </text>
        }
      >
        <text fg={tokens.state.running} wrapMode="none">
          {`  ${glyph.connector} ${current() ?? "thinking…"}`}
        </text>
      </Show>
    </box>
  )
}

export const NodeDetail = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const row = createMemo(() => treeCurrentRow(store.nav(), store.projection()))
  const node = createMemo(() => {
    const r = row()
    if (r === undefined || r.display.kind !== "node") return undefined
    const id = r.display.nodeId
    return store.sidePane().treeNodes?.find((n) => n.id === id)
  })
  return (
    <Show
      when={node() !== undefined}
      fallback={
        <Show
          when={row()?.display.kind === "conversation"}
          fallback={<text fg={tokens.text.dim}>(nothing selected)</text>}
        >
          <RootView ctx={props.ctx} label={(row()!.display as { label: string }).label} />
        </Show>
      }
    >
      <NodeView ctx={props.ctx} node={node()!} />
    </Show>
  )
}
