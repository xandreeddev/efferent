import { Match, Switch } from "solid-js"
import { Pane } from "../../ui/index.js"
import type { TuiContext } from "../../../state/store.js"
import { Activity } from "./Activity.js"
import { ContextView } from "./Context.js"
import { ContextTreeView } from "./ContextTree.js"

/**
 * The side pane: a bordered box whose contents switch between the **Activity**
 * dashboard (live execution tree + stats), the **Context** viewer (the
 * foldable/selectable turn + handoff tree), and the **Tree** viewer (the
 * persistent branching agent-context tree). `sidePane.view` drives the switch;
 * the title follows it. Width: a fixed 38% column, or the full middle region
 * when this pane is focused + zoomed.
 */
export const Side = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const focused = () => store.focus() === "side"
  const view = () => store.sidePane().view
  const title = () =>
    view() === "context" ? "context" : view() === "tree" ? "tree" : "activity"

  return (
    <Pane
      kind="side"
      focused={focused()}
      title={title()}
      width={store.zoomed() && focused() ? "100%" : "38%"}
    >
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
