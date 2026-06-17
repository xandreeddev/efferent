import { For, Match, Switch } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Pane } from "../../ui/index.js"
import { glyph, tokens } from "../../../state/theme.js"
import type { TuiContext } from "../../../state/store.js"
import { Activity } from "./Activity.js"
import { ContextView } from "./Context.js"
import { ContextTreeView } from "./ContextTree.js"
import { NodeDetail } from "./NodeDetail.js"
import { SessionsView } from "./Sessions.js"

const VIEWS = [
  { id: "stack", label: "activity" },
  { id: "context", label: "context" },
  { id: "tree", label: "agents" },
  { id: "sessions", label: "sessions" },
] as const

/**
 * The side pane: a bordered box with three views (`v` cycles, the tab row
 * shows where you are). **activity** and **context** take the whole pane; the
 * **agents** view splits it — the navigator tree on TOP holds the cursor,
 * and BELOW it a live **detail section** mirrors whatever the cursor is on
 * (full summary / files / seed for a node, its live tool feed while running,
 * session identity for a conversation). Width: a fixed
 * 38% column, or the full middle region when this pane is focused + zoomed.
 */
export const Side = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const dims = useTerminalDimensions()
  const focused = () => store.focus() === "side"
  const view = () => store.sidePane().view
  // Full region when zoomed OR when the narrow breakpoint hid the other pane
  // (App only renders one pane below 110 cols — a 38% orphan wastes the rest).
  const full = () => focused() && (store.zoomed() || dims().width < 110)

  // A rule-style head (`── agents ──`) — the corner glyph read as a tree row.
  const sectionHead = (label: string) => (
    <text fg={focused() ? tokens.accent.side : tokens.text.dim} flexShrink={0}>
      {`${glyph.seedRule} ${label} ${glyph.seedRule}`}
    </text>
  )

  return (
    <Pane
      kind="side"
      focused={focused()}
      title=""
      width={full() ? "100%" : "38%"}
    >
      {/* The view switcher doubles as the pane header (no box title): the active
          tab leads with a pointer and carries the side accent ONLY when the pane
          is focused (dim otherwise) — so it's also the focus cue now that the
          border is gone. A blank line below separates the chrome from content. */}
      <box flexDirection="row" flexShrink={0} marginBottom={1}>
        <For each={VIEWS}>
          {(v, i) => (
            <>
              <text fg={view() === v.id ? (focused() ? tokens.accent.side : tokens.text.muted) : tokens.text.dim}>
                {view() === v.id ? `${glyph.pointer} ${v.label}` : v.label}
              </text>
              {i() < VIEWS.length - 1 && <text fg={tokens.text.dim}>{"  ·  "}</text>}
            </>
          )}
        </For>
      </box>
      <Switch fallback={<Activity ctx={props.ctx} />}>
        <Match when={view() === "context"}>
          <ContextView ctx={props.ctx} />
        </Match>
        <Match when={view() === "tree"}>
          {/* Tree on top (holds the cursor); the detail mirrors the cursor
              BELOW it, content-sized (capped at half) — a three-line detail
              must not cost fifty percent of the pane. */}
          <box flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
            {sectionHead("agents")}
            <ContextTreeView ctx={props.ctx} />
          </box>
          <box flexDirection="column" flexShrink={0} maxHeight="50%" overflow="hidden" marginTop={1}>
            {sectionHead("selected")}
            <NodeDetail ctx={props.ctx} />
          </box>
        </Match>
        <Match when={view() === "sessions"}>
          <SessionsView ctx={props.ctx} />
        </Match>
      </Switch>
    </Pane>
  )
}
