import { theme } from "../../theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The bordered keybind box. Its border + title take the focused pane's accent,
 * and the title carries `<pane> · <MODE>` — the only place the mode shows (the
 * status bar stays `model · tokens · storage · cwd`). Two rows: a dim global
 * `nav` row (identical everywhere) over a row of the focused pane's own keys,
 * reflecting the real bindings (vim modal editing is deferred).
 */
const NAV_ROW = "nav   ^h/j/k/l move pane · : cmd · / search · z zoom · ^C quit"

const paneRow = (ctx: TuiContext): string => {
  const { store } = ctx
  switch (store.focus()) {
    case "conversation":
      return "conv  j/k·↑↓ scroll · ^D/^U half · gg/G ends · / search (n/N) · Z fold all"
    case "side":
      return store.sidePane().view === "context"
        ? "ctx   j/k move · h/l·←→ fold · ↵ jump · Space pick · b build · i insert"
        : "act   j/k·↑↓ move · ⇥/↵/←→ fold · i insert"
    case "input":
      return "input type to compose · ⇧↵ send · ↵ newline · : cmd · / search"
  }
}

const paneLabel = (ctx: TuiContext): string => {
  const { store } = ctx
  if (store.focus() === "side" && store.sidePane().view === "context") return "context"
  return store.focus()
}

export const Keybinds = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const accent = () => theme.accent[store.focus()]
  const title = () => ` ${paneLabel(props.ctx)} · ${store.mode().toUpperCase()} `

  return (
    <box
      border
      title={title()}
      borderColor={accent()}
      flexShrink={0}
      flexDirection="column"
    >
      <text fg={theme.dim}>{NAV_ROW}</text>
      <text fg={theme.gray}>{paneRow(props.ctx)}</text>
    </box>
  )
}
