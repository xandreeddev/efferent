import { For, Match, Switch } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { Pane } from "../../ui/index.js"
import { tokens } from "../../../state/theme.js"
import type { TuiContext } from "../../../state/store.js"
import { Activity } from "./Activity.js"
import { ContextView } from "./Context.js"
import { ContextTreeView } from "./ContextTree.js"

const VIEWS = [
  { id: "stack", label: "activity" },
  { id: "context", label: "context" },
  { id: "tree", label: "tree" },
] as const

/**
 * The side pane: a bordered box whose contents switch between the **Activity**
 * dashboard (live execution tree + stats), the **Context** viewer (the
 * foldable/selectable turn + handoff tree), and the **Tree** viewer (the
 * persistent branching agent-context tree). `sidePane.view` drives the switch;
 * the title follows it, and a tab row makes the sibling views *visible* —
 * without it nothing tells a user the other two exist (`v` cycles them;
 * `:context`/`:tree` jump directly). Width: a fixed 38% column, or the full
 * middle region when this pane is focused + zoomed.
 */
export const Side = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const dims = useTerminalDimensions()
  const focused = () => store.focus() === "side"
  const view = () => store.sidePane().view
  const title = () =>
    view() === "context" ? "context" : view() === "tree" ? "tree" : "activity"
  // Full region when zoomed OR when the narrow breakpoint hid the other pane
  // (App only renders one pane below 110 cols — a 38% orphan wastes the rest).
  const full = () => focused() && (store.zoomed() || dims().width < 110)

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
          <ContextTreeView ctx={props.ctx} />
        </Match>
      </Switch>
    </Pane>
  )
}
