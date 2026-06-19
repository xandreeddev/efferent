import { createMemo, Show } from "solid-js"
import type { Overlay as OverlayState, TuiContext } from "../../state/store.js"
import type { SelectState } from "../../presentation/selectBox.js"
import type { BottomMenuItem } from "../ui/index.js"
import { BottomMenu, type KeyHint } from "../ui/index.js"

/** Picker footer — agy's "Navigate / Select / Cancel" (filtering is live as you
 *  type, like the command palette, so it needs no separate advertisement). */
const PICKER_FOOTER: ReadonlyArray<KeyHint> = [
  { key: "↑/↓", label: "Navigate" },
  { key: "type", label: "filter" },
  { key: "↵", label: "Select" },
  { key: "esc", label: "Cancel" },
]

/** Generous label budget — picker labels (model ids, themes) are short enough to
 *  never truncate at any real terminal width; the inline menu spans the column. */
const LABEL_W = 64

/**
 * The inline **select picker** — `:model`/`:theme`/`:effort`/`:search`/`:logout`/
 * `:browse`/`:db` and the startup resume picker. Renders the active `select`
 * overlay as a **borderless agy contextual menu** in the bottom chrome (below the
 * fence) via the shared {@link BottomMenu} — NOT a floating bordered modal (the
 * `Overlay` host deliberately skips `select` so this owns it). State + keys are
 * unchanged (`keys/overlay.ts` still drives nav/filter/submit on the same
 * `SelectState`); only the surface moved from a modal to inline.
 */
export const SelectMenu = (props: { ctx: TuiContext }) => {
  const o = (): OverlayState => props.ctx.store.overlay()
  // The active select state, or undefined for any other overlay. The keyed `Show`
  // below only evaluates its child (and the `.matches` access) when this is
  // truthy — so it never touches `.sel` on a non-select overlay at idle.
  const selState = createMemo((): SelectState<unknown> | undefined => {
    const ov = o()
    return ov.kind === "select" ? ov.sel : undefined
  })
  return (
    <Show when={selState()}>
      {(sel) => (
        <BottomMenu
          title={sel().title}
          items={sel().matches.map(
            (m): BottomMenuItem => ({ label: m.label, desc: m.desc, tag: m.tag, active: m.active }),
          )}
          selected={sel().selected}
          labelBudget={LABEL_W}
          footer={PICKER_FOOTER}
        />
      )}
    </Show>
  )
}
