import { For, Match, Switch } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Pane } from "../../ui/index.js"
import { glyph, tokens } from "../../../state/theme.js"
import type { TuiContext } from "../../../state/store.js"
import { Activity } from "./Activity.js"
import { ContextView } from "./Context.js"
import { ContextTreeView } from "./ContextTree.js"

const VIEWS = [
  { id: "stack", label: "activity" },
  { id: "context", label: "context" },
  { id: "tree", label: "agents" },
] as const

/**
 * The side pane: a bordered box. **Activity and the agents tree render
 * together, stacked half-and-half** — `sidePane.view` decides which of the two
 * owns the keyboard (cursor/folds; `v` cycles, `:tree` jumps) and the tab row
 * + each half's header show where the keys are. The **context viewer** is a
 * different tool (curation) and still takes the whole pane when active.
 * Width: a fixed 38% column, or the full middle region when this pane is
 * focused + zoomed.
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

  const half = (label: string, keyed: boolean) => (
    <text fg={keyed && focused() ? tokens.accent.side : tokens.text.dim} flexShrink={0}>
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
      <Switch
        fallback={
          <>
            <box flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
              {half("activity", view() === "stack")}
              <Activity ctx={props.ctx} />
            </box>
            <box flexDirection="column" flexGrow={1} flexBasis={0} overflow="hidden">
              {half("agents", view() === "tree")}
              <ContextTreeView ctx={props.ctx} />
            </box>
          </>
        }
      >
        <Match when={view() === "context"}>
          <ContextView ctx={props.ctx} />
        </Match>
      </Switch>
    </Pane>
  )
}
