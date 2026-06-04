import { Show } from "solid-js"
import { Pane } from "../../ui/index.js"
import type { TuiContext } from "../../../state/store.js"
import { Activity } from "./Activity.js"
import { ContextView } from "./Context.js"

/**
 * The side pane: a bordered box whose contents switch between the **Activity**
 * dashboard (live execution tree + stats) and the **Context** viewer (the
 * foldable/selectable turn + handoff tree). `sidePane.view` drives the switch;
 * the title follows it. Width: a fixed 38% column, or the full middle region
 * when this pane is focused + zoomed.
 */
export const Side = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const focused = () => store.focus() === "side"
  const isContext = () => store.sidePane().view === "context"

  return (
    <Pane
      kind="side"
      focused={focused()}
      title={isContext() ? "context" : "activity"}
      width={store.zoomed() && focused() ? "100%" : "38%"}
    >
      <Show when={isContext()} fallback={<Activity ctx={props.ctx} />}>
        <ContextView ctx={props.ctx} />
      </Show>
    </Pane>
  )
}
