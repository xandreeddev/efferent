import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, For, Show } from "solid-js"
import { sessionsRows } from "../../../presentation/sidePane.js"
import { glyph, tokens } from "../../../state/theme.js"
import type { TuiContext } from "../../../state/store.js"

/**
 * The **sessions** view (`:sessions`): every conversation sharing this
 * workspace path, one per row, the live one tagged `◀ active`. `↵` swaps the
 * active session (the composer follows); the agents view then shows that
 * session's execution tree. A flat list — no folds, just the cursor.
 */
export const SessionsView = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const focused = () => store.focus() === "side" && store.sidePane().view === "sessions"
  const rows = () => sessionsRows(store.sidePane())
  const cursor = () => store.sidePane().sessionsCursor

  let sb!: ScrollBoxRenderable
  createEffect(() => {
    const i = cursor()
    if (sb) sb.scrollChildIntoView(`sess-row-${i}`)
  })

  return (
    <scrollbox
      ref={sb}
      scrollY
      flexGrow={1}
      flexDirection="column"
      verticalScrollbarOptions={{ visible: false }}
    >
      <Show
        when={rows().length > 0}
        fallback={<text fg={tokens.text.dim}>(no sessions yet — chat to start one)</text>}
      >
        <For each={rows()}>
          {(row, i) => (
            <box
              id={`sess-row-${i()}`}
              flexDirection="row"
              backgroundColor={focused() && i() === cursor() ? tokens.cursorLine : tokens.bgNone}
            >
              <text
                fg={row.active ? tokens.text.default : tokens.text.muted}
                wrapMode="none"
              >
                {row.label}
              </text>
              <Show when={row.active}>
                <text fg={tokens.accent.side} wrapMode="none" flexShrink={0}>
                  {`  ${glyph.activeTag} active`}
                </text>
              </Show>
            </box>
          )}
        </For>
      </Show>
    </scrollbox>
  )
}
