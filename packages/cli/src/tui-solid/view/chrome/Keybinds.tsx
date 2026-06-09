import { tokens } from "../../state/theme.js"
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
      return "conv  j/k scroll · {}/[] para/msg · ⇥/↵ fold · gg/G ends · / search · Z fold all"
    case "side":
      switch (store.sidePane().view) {
        case "context":
          return "ctx   j/k·{} move · [] head · ⇥/↵ fold · Space pick · b build · / search"
        case "tree":
          return "tree  j/k·{} move · [] root · ⇥/↵ fold · d drop · / search · i insert"
        default:
          return "act   j/k·{} move · [] head · ⇥/↵ fold · gg/G ends · / search · i insert"
      }
    case "input":
      return "input type to compose · ⇧↵ send · ↵ newline · : cmd · / search"
  }
}

const paneLabel = (ctx: TuiContext): string => {
  const { store } = ctx
  if (store.focus() === "side") {
    const v = store.sidePane().view
    if (v === "context") return "context"
    if (v === "tree") return "tree"
  }
  return store.focus()
}

export const Keybinds = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const accent = () => tokens.accent[store.focus()]
  const title = () => ` ${paneLabel(props.ctx)} · ${store.mode().toUpperCase()} `

  return (
    <box
      border
      title={title()}
      borderColor={accent()}
      flexShrink={0}
      flexDirection="column"
    >
      <text fg={tokens.text.dim}>{NAV_ROW}</text>
      <text fg={tokens.text.muted}>{paneRow(props.ctx)}</text>
    </box>
  )
}
