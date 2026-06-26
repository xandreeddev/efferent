import { createMemo, Match, Show, Switch } from "solid-js"
import type { Overlay as OverlayState, TuiContext } from "../../state/store.js"
import type { SelectState } from "../../presentation/selectBox.js"
import type { LoginFlow } from "../../presentation/loginFlow.js"
import { SelectList } from "./SelectList.js"
import { PromptBox } from "./PromptBox.js"

type StepView =
  | { readonly tag: "select"; readonly sel: SelectState<unknown> }
  | { readonly tag: "prompt"; readonly title: string; readonly prompt: string; readonly value: string; readonly mask: boolean }

/** Map the active login step to renderable props (mirrors `renderLoginFlow`). */
const stepView = (flow: LoginFlow): StepView => {
  switch (flow.step) {
    case "home":
    case "method":
      return { tag: "select", sel: flow.sel }
    case "apiKey":
    case "localUrl":
      return { tag: "prompt", title: flow.prompt.title, prompt: flow.prompt.prompt, value: flow.prompt.value, mask: flow.prompt.mask }
    case "oauth":
      return {
        tag: "prompt",
        title: flow.manual.title,
        // The OAuth step shows its live status on the instruction line.
        prompt: `${flow.status} — ${flow.manual.prompt}`,
        value: flow.manual.value,
        mask: flow.manual.mask,
      }
  }
}

/**
 * The `:login` flow — a **borderless inline** sheet in the bottom chrome (agy: no
 * floating modal). A select step (auth method / provider) renders the shared
 * `SelectList`; a text step (API key / OAuth redirect / local URL) renders the
 * `PromptBox`. Reads the active login overlay from the store (keyed `Show` so it
 * never reads `.flow` off another overlay); the pure `LoginFlow` state machine
 * drives every transition, keys come from `keys/overlay.ts`.
 */
const LoginFlowView = (props: { flow: LoginFlow }) => {
  const view = createMemo(() => stepView(props.flow))
  return (
    <Switch>
      <Match when={view().tag === "select"}>
        <SelectList state={(view() as Extract<StepView, { tag: "select" }>).sel} />
      </Match>
      <Match when={view().tag === "prompt"}>
        {(() => {
          const v = view() as Extract<StepView, { tag: "prompt" }>
          return <PromptBox title={v.title} prompt={v.prompt} value={v.value} mask={v.mask} />
        })()}
      </Match>
    </Switch>
  )
}

export const Login = (props: { ctx: TuiContext }) => {
  const flow = createMemo((): LoginFlow | undefined => {
    const o: OverlayState = props.ctx.store.overlay()
    return o.kind === "login" ? o.flow : undefined
  })
  return <Show when={flow()}>{(f) => <LoginFlowView flow={f()} />}</Show>
}
