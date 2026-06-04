import { Show } from "solid-js"
import { theme } from "../../theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The `/` search status line — shown above the input while a conversation
 * search is active. Mirrors the old TUI's `[i/total]` search overlay: the query,
 * the position among matches, and the n/N·Esc hints (or a no-match note).
 */
export const SearchStatus = (props: { ctx: TuiContext }) => {
  const s = () => props.ctx.store.search()
  return (
    <Show when={s()}>
      {(st) => (
        <box flexDirection="row" flexShrink={0}>
          <text fg={theme.select}>{`/${st().query}  `}</text>
          <text fg={st().matchIds.length === 0 ? theme.error : theme.gray}>
            {st().matchIds.length === 0
              ? "no matches"
              : `[${st().index + 1}/${st().matchIds.length}]  n/N next·prev · Esc clear`}
          </text>
        </box>
      )}
    </Show>
  )
}
