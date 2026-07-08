import { Match as M } from "effect"
import { Show } from "solid-js"
import { tokens } from "../theme.js"
import { BottomMenu } from "./ui/BottomMenu.js"
import type { BottomMenuItem } from "./ui/BottomMenu.js"
import { PromptBody } from "./ui/PromptBody.js"
import type { SelectState } from "../presentation/selectBox.js"
import type { SmithTuiContext } from "../state/store.js"

/**
 * The inline contextual surface below the status rows — renders whatever
 * overlay is open (a picker or the login flow) while the composer is
 * unmounted. One `Match` on the overlay kind; the login flow adds its own
 * step-level branches (menus render through the SAME BottomMenu).
 */

const LABEL_BUDGET = 64

const menuItems = <T,>(sel: SelectState<T>): ReadonlyArray<BottomMenuItem> =>
  sel.matches.map((o) => ({
    label: o.label,
    desc: o.desc,
    tag: o.tag,
    active: o.active,
  }))

const FilterLine = (props: { filter: string }) => (
  <Show when={props.filter.length > 0}>
    <box flexDirection="row">
      <text fg={tokens.accent.input}>{"  filter: "}</text>
      <text fg={tokens.text.bright}>{props.filter}</text>
    </box>
  </Show>
)

const SELECT_FOOTER = [
  { key: "↑/↓", label: "navigate" },
  { key: "⏎", label: "select" },
  { key: "esc", label: "close" },
  { key: "type", label: "filter" },
]

const LOGIN_MENU_FOOTER = [
  { key: "↑/↓", label: "navigate" },
  { key: "⏎", label: "select" },
  { key: "esc", label: "back" },
]


export const OverlayView = (props: { ctx: SmithTuiContext }) => {
  const overlay = props.ctx.store.overlay
  return (
    <box flexDirection="column" flexShrink={0} marginTop={1}>
      {M.value(overlay()).pipe(
        M.when({ kind: "select" }, (o) => (
          <box flexDirection="column">
            <FilterLine filter={o.sel.filter} />
            <BottomMenu
              items={menuItems(o.sel)}
              selected={o.sel.selected}
              title={o.sel.title}
              labelBudget={LABEL_BUDGET}
              footer={SELECT_FOOTER}
            />
          </box>
        )),
        M.when({ kind: "login" }, (o) =>
          M.value(o.flow).pipe(
            M.when({ step: "home" }, (flow) => (
              <box flexDirection="column">
                <FilterLine filter={flow.sel.filter} />
                <BottomMenu
                  items={menuItems(flow.sel)}
                  selected={flow.sel.selected}
                  title={flow.sel.title}
                  labelBudget={LABEL_BUDGET}
                  footer={LOGIN_MENU_FOOTER}
                />
              </box>
            )),
            M.when({ step: "method" }, (flow) => (
              <BottomMenu
                items={menuItems(flow.sel)}
                selected={flow.sel.selected}
                title={flow.sel.title}
                labelBudget={LABEL_BUDGET}
                footer={LOGIN_MENU_FOOTER}
              />
            )),
            M.when({ step: "apiKey" }, (flow) => (
              <box flexDirection="column">
                <PromptBody prompt={flow.prompt} />
                <box height={1} />
                <box paddingLeft={2}>
                  <text fg={tokens.text.dim}>{"⏎ submit · esc back — the key is masked"}</text>
                </box>
              </box>
            )),
            M.when({ step: "oauth" }, (flow) => (
              <box flexDirection="column">
                <text fg={tokens.state.running} wrapMode="none">{`  ${flow.status}`}</text>
                <text fg={tokens.text.dim} wrapMode="none">{`  ${flow.authorizeUrl}`}</text>
                <box height={1} />
                <PromptBody prompt={flow.manual} />
                <box height={1} />
                <box paddingLeft={2}>
                  <text fg={tokens.text.dim}>{"⏎ submit the pasted redirect · esc cancel"}</text>
                </box>
              </box>
            )),
            M.exhaustive,
          ),
        ),
        M.orElse(() => null),
      )}
    </box>
  )
}
