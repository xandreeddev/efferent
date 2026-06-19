import { createMemo, For, Show } from "solid-js"
import { computePalette, PALETTE_VISIBLE } from "../../presentation/slashPalette.js"
import { clampCursor } from "../../presentation/paneNav.js"
import { glyph } from "../../state/theme.js"
import { KeyHints, MenuRow, type KeyHint } from "../ui/index.js"
import type { TuiContext } from "../../state/store.js"

/** The agy contextual-menu footer — same `KeyHints` painter every picker uses. */
const PALETTE_FOOTER: ReadonlyArray<KeyHint> = [
  { key: "↑/↓", label: "navigate" },
  { key: "⇥/→", label: "complete" },
  { key: "↵", label: "run" },
]

// Command names pad to one column so the descriptions align (agy contextual
// menu). The widest is ":onboarding" (11) — pad to 12 and let MenuRow keep it.
const NAME_W = 12

/**
 * The `:` command menu — the agy contextual menu shown **below** the input as the
 * user types a `:` command. Rendered through the shared {@link MenuRow} +
 * {@link KeyHints} primitives, so it's the SAME caret/row/footer as every select
 * picker: change the menu look once, this follows. The highlighted row is
 * `store.paletteIndex()` (moved by ↑/↓), which `⇥`/`→` complete to and `↵` runs
 * (see `keys/dispatch.ts:inputKey`).
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
            <MenuRow
              selected={i() === selected()}
              marker={i() === selected() ? glyph.pointer : " "}
              label={c.name.padEnd(NAME_W)}
              labelBudget={NAME_W}
              desc={c.description}
            />
          )}
        </For>
        <KeyHints hints={PALETTE_FOOTER} />
      </box>
    </Show>
  )
}
