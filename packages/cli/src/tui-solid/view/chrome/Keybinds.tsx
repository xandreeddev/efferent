import { tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * Keybind help — ONE dim strip with the focused context's essential keys plus
 * `? keys` (which opens the full command + keybind reference overlay — see
 * `presentation/helpView.ts`). Chrome must not out-weigh content; on a 24-row
 * terminal a multi-row box ate a sixth of the screen to repeat itself, and the
 * `?` overlay now carries the exhaustive vocabulary.
 *
 * The hints lead with keys that work in EVERY terminal (Esc, w, :, /) — the
 * Ctrl encodings die in legacy/tmux input modes, so they're the alternative,
 * not the headline. Both audiences read the same row: vi hands see Esc/w,
 * non-vi users see a visible, modifier-free path to every pane.
 */

/** The one-row strip: the focused context's essentials + how to get more. */
const strip = (ctx: TuiContext): string => {
  const { store } = ctx
  if (store.focus() === "input") return "esc panes · : cmd · / search · ↵ send"
  const pane =
    store.focus() === "side"
      ? store.sidePane().view === "context"
        ? "Space pick · b build"
        : store.sidePane().view === "tree"
          ? "↵ open · c fork · d drop"
          : store.sidePane().view === "sessions"
            ? "↵ switch · F2 rename"
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

  return (
    <box flexDirection="row" flexShrink={0}>
      {/* The focused context's name leads in its accent — without it the
          strip is an anonymous key soup and you can't tell what pane the
          keys belong to. */}
      <text fg={accent()} flexShrink={0}>{` ${paneLabel(props.ctx)} `}</text>
      <text fg={tokens.text.dim} wrapMode="none">
        {` ${strip(props.ctx)}`}
      </text>
    </box>
  )
}
