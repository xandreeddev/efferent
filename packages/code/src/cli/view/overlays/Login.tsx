import { createMemo, Match, Switch } from "solid-js"
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
 * The `:login` overlay: a select step (auth method / provider) renders the shared
 * `SelectList`; a text step (API key / OAuth redirect / local URL) renders the
 * `PromptBox`. The pure `LoginFlow` state machine (`tui/loginFlow.ts`) drives
 * every transition; this is just its view.
 */
export const Login = (props: { flow: LoginFlow }) => {
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
