import { createMemo, For, Show } from "solid-js"
import { computePalette, PALETTE_VISIBLE } from "../../presentation/slashPalette.js"
import { clampCursor } from "../../presentation/paneNav.js"
import { glyph, tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The `:` command autocomplete overlay — shown above the input as the user types
 * a `:` command. Reuses `slashPalette.ts`'s `computePalette`; the highlighted row
 * is `store.paletteIndex()` (moved by ↑/↓), which `⇥`/`→` complete to and `↵`
 * runs (see `keys/dispatch.ts:inputKey`).
 */
export const SlashPalette = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const palette = createMemo(() => computePalette(store.input()))
  const matches = createMemo(() => palette().matches.slice(0, PALETTE_VISIBLE))
  const selected = createMemo(() => clampCursor(matches().length, store.paletteIndex()))
  return (
    <Show when={palette().visible}>
      <box flexDirection="column" flexShrink={0}>
        <For each={matches()}>
          {(c, i) => (
            <box flexDirection="row">
              <text fg={i() === selected() ? tokens.accent.conversation : tokens.text.dim}>
                {i() === selected() ? `${glyph.pointer} ` : "  "}
              </text>
              <text fg={tokens.text.default}>{c.name.padEnd(12)}</text>
              <text fg={tokens.text.muted}>{`  ${c.description}`}</text>
            </box>
          )}
        </For>
        <text fg={tokens.text.dim}>{"  ↑↓ select · ⇥/→ complete · ↵ run"}</text>
      </box>
    </Show>
  )
}
