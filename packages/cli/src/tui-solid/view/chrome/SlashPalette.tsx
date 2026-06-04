import { createMemo, For, Show } from "solid-js"
import { computePalette } from "../../presentation/slashPalette.js"
import { theme } from "../../theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The `:` command autocomplete overlay — shown above the input as the user types
 * a `:` command. Reuses `slashPalette.ts`'s `computePalette`; the first match is
 * highlighted because Enter resolves a typed prefix to its unique command.
 */
export const SlashPalette = (props: { ctx: TuiContext }) => {
  const palette = createMemo(() => computePalette(props.ctx.store.input()))
  return (
    <Show when={palette().visible}>
      <box flexDirection="column" flexShrink={0}>
        <For each={palette().matches.slice(0, 6)}>
          {(c, i) => (
            <box flexDirection="row">
              <text fg={i() === 0 ? theme.accent.conversation : theme.dim}>
                {i() === 0 ? "▸ " : "  "}
              </text>
              <text fg={theme.text}>{c.name.padEnd(12)}</text>
              <text fg={theme.gray}>{`  ${c.description}`}</text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
