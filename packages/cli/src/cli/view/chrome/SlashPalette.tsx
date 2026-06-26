import { createMemo, Show } from "solid-js"
import { computePalette } from "../../presentation/slashPalette.js"
import { clampCursor } from "../../presentation/paneNav.js"
import { BottomMenu, type KeyHint } from "../ui/index.js"
import type { TuiContext } from "../../state/store.js"

/** The agy command-palette footer (matches agy's wording: Navigate/Select/Complete). */
const PALETTE_FOOTER: ReadonlyArray<KeyHint> = [
  { key: "↑/↓", label: "Navigate" },
  { key: "enter", label: "Select" },
  { key: "tab", label: "Complete" },
]

// Command names pad to one column so the descriptions align (agy contextual
// menu). The widest is ":onboarding" (11) — pad to 12.
const NAME_W = 12

/**
 * The `:` command menu — the agy borderless contextual menu shown **below** the
 * input fence as the user types a `:` command. Rendered through the shared
 * {@link BottomMenu} (the SAME renderer every picker uses): `>` pointer, dim
 * descriptions, `↑/↓ N more` overflow lines, a blank line, then the indented
 * footer. The highlighted row is `store.paletteIndex()` (moved by ↑/↓ over the
 * FULL match list — `keys/dispatch.ts:inputKey`), which `⇥`/`→` complete to and
 * `↵` runs.
 */
export const SlashPalette = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const palette = createMemo(() => computePalette(store.input()))
  const items = createMemo(() =>
    palette().matches.map((c) => ({ label: c.name.padEnd(NAME_W), desc: c.description })),
  )
  const selected = createMemo(() => clampCursor(items().length, store.paletteIndex()))
  return (
    <Show when={palette().visible}>
      <BottomMenu items={items()} selected={selected()} labelBudget={NAME_W} footer={PALETTE_FOOTER} maxRows={6} />
    </Show>
  )
}
