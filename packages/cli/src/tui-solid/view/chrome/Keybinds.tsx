import { Show } from "solid-js"
import { tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * Keybind help, two densities:
 *
 *  - **Strip** (default): ONE dim row — the focused context's essential keys.
 *    Chrome must not out-weigh content; on a 24-row terminal the old 4-row box
 *    ate a sixth of the screen to repeat itself.
 *  - **Box** (`?` in NORMAL, or `keysExpanded`): the bordered two-row version
 *    with the full vocabulary — border + title take the focused pane's accent,
 *    title carries `<pane> · <MODE>`.
 *
 * The hints lead with keys that work in EVERY terminal (Esc, w, :, /) — the
 * Ctrl encodings die in legacy/tmux input modes, so they're the alternative,
 * not the headline. Both audiences read the same row: vi hands see Esc/w,
 * non-vi users see a visible, modifier-free path to every pane.
 */
const NAV_FULL = "nav   esc panes · w next pane · ^k/^l conv/side · : cmd · / search · z zoom · ^C quit"

const paneRow = (ctx: TuiContext): string => {
  const { store } = ctx
  switch (store.focus()) {
    case "conversation":
      return "conv  j/k scroll · {}/[] para/msg · ⇥/↵ fold · gg/G ends · Z fold all · w side · i type"
    case "side":
      switch (store.sidePane().view) {
        case "context":
          return "ctx   j/k·{} move · [] head · ⇥/↵ fold · Space pick · b build · v views · i type"
        case "tree":
          return "agents j/k·{} move · [] root · ⇥ fold · ↵ open · c fork · d drop · q close · v views"
        case "sessions":
          return "sess  j/k move · gg/G ends · ↵ switch session · v views · i type"
        default:
          return "act   j/k·{} move · [] head · ⇥/↵ fold · gg/G ends · v views · i type"
      }
    case "input":
      return "input ⇧↵ send · ↵ newline · esc panes · : cmd · / search"
  }
}

/** The one-row strip: the focused context's essentials + how to get more. */
const strip = (ctx: TuiContext): string => {
  const { store } = ctx
  if (store.focus() === "input") return "esc panes · : cmd · / search · ⇧↵ send"
  const pane =
    store.focus() === "side"
      ? store.sidePane().view === "context"
        ? "Space pick · b build"
        : store.sidePane().view === "tree"
          ? "↵ open · c fork · d drop"
          : store.sidePane().view === "sessions"
            ? "↵ switch session"
            : "↵ fold"
      : store.nodePreview() !== undefined
        ? "j/k scroll · q close preview"
        : "j/k scroll · ↵ fold"
  return `${pane} · w next pane · v views · i type · ? keys`
}

const paneLabel = (ctx: TuiContext): string => {
  const { store } = ctx
  if (store.focus() === "side") {
    const v = store.sidePane().view
    if (v === "context") return "context"
    if (v === "tree") return "agents"
    if (v === "sessions") return "sessions"
  }
  return store.focus()
}

export const Keybinds = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const accent = () => tokens.accent[store.focus()]
  const title = () => ` ${paneLabel(props.ctx)} · ${store.mode().toUpperCase()} `

  return (
    <Show
      when={store.keysExpanded()}
      fallback={
        <text fg={tokens.text.dim} flexShrink={0}>
          {` ${strip(props.ctx)}`}
        </text>
      }
    >
      <box
        border
        title={title()}
        borderColor={accent()}
        flexShrink={0}
        flexDirection="column"
      >
        <text fg={tokens.text.dim}>{NAV_FULL}</text>
        <text fg={tokens.text.muted}>{paneRow(props.ctx)}</text>
      </box>
    </Show>
  )
}
