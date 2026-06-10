import { For, Match, Switch } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Pane } from "../../ui/index.js"
import { glyph, tokens } from "../../../state/theme.js"
import type { TuiContext } from "../../../state/store.js"
import { Activity } from "./Activity.js"
import { ContextView } from "./Context.js"
import { ContextTreeView } from "./ContextTree.js"
import { NodeDetail } from "./NodeDetail.js"

const VIEWS = [
  { id: "stack", label: "activity" },
  { id: "context", label: "context" },
  { id: "tree", label: "agents" },
] as const

/**
 * The side pane: a bordered box with three views (`v` cycles, the tab row
 * shows where you are). **activity** and **context** take the whole pane; the
 * **agents** view splits it — the navigator tree in the LOWER half holds the
 * cursor, and the UPPER half is a live **detail section** mirroring whatever
 * the cursor is on (full summary / files / seed for a node, its live tool
 * feed while running, session identity for a conversation). Width: a fixed
 * 38% column, or the full middle region when this pane is focused + zoomed.
 */
export const Side = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const dims = useTerminalDimensions()
  const focused = () => store.focus() === "side"
  const view = () => store.sidePane().view
  const title = () =>
    view() === "context" ? "context" : view() === "tree" ? "agents" : "activity"
  // Full region when zoomed OR when the narrow breakpoint hid the other pane
  // (App only renders one pane below 110 cols — a 38% orphan wastes the rest).
  const full = () => focused() && (store.zoomed() || dims().width < 110)

  const sectionHead = (label: string) => (
    <text fg={focused() ? tokens.accent.side : tokens.text.dim} flexShrink={0}>
      {`${glyph.tree.corner} ${label}`}
    </text>
  )

  return (
    <Pane
      kind="side"
      focused={focused()}
      title={title()}
      width={full() ? "100%" : "38%"}
    >
      <box flexDirection="row" flexShrink={0}>
        <For each={VIEWS}>
          {(v, i) => (
            <>
              <text fg={view() === v.id ? tokens.accent.side : tokens.text.dim}>
                {v.label}
              </text>
              {i() < VIEWS.length - 1 && <text fg={tokens.text.dim}>{" · "}</text>}
            </>
          )}
        </For>
      </box>
      <Switch fallback={<Activity ctx={props.ctx} />}>
        <Match when={view() === "context"}>
          <ContextView ctx={props.ctx} />
        </Match>
        <Match when={view() === "tree"}>
          <box flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
            {sectionHead("selected")}
            <NodeDetail ctx={props.ctx} />
          </box>
          <box flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
            {sectionHead("agents")}
            <ContextTreeView ctx={props.ctx} />
          </box>
        </Match>
      </Switch>
    </Pane>
  )
}
