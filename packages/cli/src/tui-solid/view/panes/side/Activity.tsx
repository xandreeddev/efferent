import { homedir } from "node:os"
import { For, Show } from "solid-js"
import { SPINNER_FRAMES } from "../../../../terminal.js"
import { formatTokens, gaugeBar } from "../../../presentation/statusBar.js"
import type { NodeStatus, TreeNode } from "../../../presentation/executionTree.js"
import type { FileChange, SidePaneState } from "../../../presentation/sidePane.js"
import { theme } from "../../../theme.js"
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
  status === "running" ? theme.tool.running : status === "error" ? theme.tool.error : theme.tool.ok

/** The Activity stats header: a context gauge + a cumulative one-liner. */
const Stats = (props: { ctx: TuiContext }) => {
  const s = () => props.ctx.store.sidePane().stats
  const win = () => (s().contextWindow > 0 ? formatTokens(s().contextWindow) : "?")
  const elapsed = () => (s().startedAt > 0 ? fmtDur(Date.now() - s().startedAt) : "0s")
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={theme.gray}>
        {`ctx ${gaugeBar(s().inputTokens, s().contextWindow, 8)} ${formatTokens(s().inputTokens)}/${win()} (${formatTokens(s().cacheReadTokens)} cached)`}
      </text>
      <text fg={theme.dim}>
        {`${formatTokens(s().outputTokens)} tok out · ${s().turns} turn${s().turns === 1 ? "" : "s"} · ${elapsed()}`}
      </text>
    </box>
  )
}

const TreeNodeView = (props: {
  node: TreeNode
  depth: number
  collapsed: ReadonlySet<string>
  spinner: number
}) => {
  const n = props.node
  const isContainer = n.kind === "turn" || n.kind === "subagent"
  const foldId = isContainer ? `node:${n.id}` : undefined
  const folded = () => foldId !== undefined && props.collapsed.has(foldId)
  const glyph = () => {
    if (isContainer) return folded() ? "▸" : "▾"
    if (n.status === "running") return SPINNER_FRAMES[props.spinner % SPINNER_FRAMES.length]
    return n.status === "error" ? "✗" : "✓"
  }
  const glyphColor = () =>
    isContainer
      ? n.status === "running"
        ? theme.tool.running
        : n.status === "error"
          ? theme.tool.error
          : theme.gray
      : statusColor(n.status)
  const suffix = () => {
    const count =
      folded() && n.children.length > 0
        ? ` · ${n.children.length} tool${n.children.length === 1 ? "" : "s"}`
        : ""
    const detail = n.detail !== undefined ? ` ${n.detail}` : ""
    const dur = isContainer ? ` ${fmtDur((n.endedAt ?? Date.now()) - n.startedAt)}` : ""
    return `${count}${detail}${dur}`
  }
  return (
    <box flexDirection="column">
      <box flexDirection="row" marginLeft={props.depth * 2}>
        <text fg={glyphColor()}>{`${glyph()} `}</text>
        <text fg={theme.text}>{n.label}</text>
        <text fg={theme.dim}>{suffix()}</text>
      </box>
      <Show when={!folded()}>
        <For each={n.children}>
          {(c) => (
            <TreeNodeView
              node={c}
              depth={props.depth + 1}
              collapsed={props.collapsed}
              spinner={props.spinner}
            />
          )}
        </For>
      </Show>
    </box>
  )
}

const SectionHead = (props: {
  label: string
  count: number
  collapsed: boolean
  summary?: string | undefined
}) => (
  <box flexDirection="row">
    <text fg={theme.gray}>{`${props.collapsed ? "▸" : "▾"} ${props.label} `}</text>
    <text fg={theme.dim}>{`(${props.count})`}</text>
    <Show when={props.summary}>
      <text fg={theme.gray}>{props.summary}</text>
    </Show>
  </box>
)

const FilesSection = (props: { files: ReadonlyArray<FileChange>; collapsed: boolean }) => {
  const tot = () =>
    props.files.reduce((a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }), {
      added: 0,
      removed: 0,
    })
  return (
    <box flexDirection="column">
      <SectionHead
        label="files"
        count={props.files.length}
        collapsed={props.collapsed}
        summary={props.files.length > 0 ? ` +${tot().added}/-${tot().removed}` : undefined}
      />
      <Show when={!props.collapsed && props.files.length > 0}>
        <For each={props.files}>
          {(f) => (
            <box flexDirection="row" marginLeft={3}>
              <text fg={theme.gray}>{`${prettyPath(f.path)} `}</text>
              <text fg={theme.tool.ok}>{`+${f.added}`}</text>
              <text fg={theme.dim}>/</text>
              <text fg={theme.tool.error}>{`-${f.removed}`}</text>
            </box>
          )}
        </For>
      </Show>
    </box>
  )
}

const ListSection = (props: { label: string; items: ReadonlyArray<string>; collapsed: boolean }) => (
  <box flexDirection="column">
    <SectionHead label={props.label} count={props.items.length} collapsed={props.collapsed} />
    <Show when={!props.collapsed && props.items.length > 0}>
      <For each={props.items}>
        {(i) => <text fg={theme.gray} marginLeft={3}>{`· ${i}`}</text>}
      </For>
    </Show>
  </box>
)

/**
 * The side pane's Activity view: a pinned stats header, the live execution tree,
 * and the foldable files/skills/instructions sections. Reproduces
 * `renderSidePane`'s stack view (`tui/sidePane.ts`) as Solid components. The
 * pane shell + view switch live in `Side.tsx`; the context viewer in `Context.tsx`.
 */
export const Activity = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const sp = (): SidePaneState => store.sidePane()
  const focused = () => store.focus() === "side"

  return (
    <>
      {/* Stats header is pinned above the scroll region so it stays visible. */}
      <Stats ctx={props.ctx} />
      <text flexShrink={0}> </text>
      <scrollbox
        focused={focused()}
        stickyScroll
        stickyStart="bottom"
        scrollY
        flexGrow={1}
        flexDirection="column"
      >
        <Show when={sp().tree.roots.length > 0} fallback={<text fg={theme.dim}>(idle)</text>}>
          <For each={sp().tree.roots}>
            {(root) => (
              <TreeNodeView node={root} depth={0} collapsed={sp().stackCollapsed} spinner={store.spinner()} />
            )}
          </For>
        </Show>
        <text> </text>
        <FilesSection files={sp().filesChanged} collapsed={sp().stackCollapsed.has("files")} />
        <ListSection label="skills" items={sp().skillsLoaded} collapsed={sp().stackCollapsed.has("skills")} />
        <ListSection
          label="instructions"
          items={sp().instructions.map((i) => prettyPath(i.path))}
          collapsed={sp().stackCollapsed.has("instructions")}
        />
      </scrollbox>
    </>
  )
}
