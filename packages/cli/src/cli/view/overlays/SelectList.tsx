import type { SelectState } from "../../presentation/selectBox.js"
import { Sheet, SHEET_RULE, SHEET_WIDTH, SelectBody } from "../ui/index.js"

/**
 * A navigable list, driving the pure `SelectState` (`presentation/selectBox.ts`).
 * The list itself is the shared {@link SelectBody} primitive; this only supplies
 * the borderless {@link Sheet} chrome (title + width), so the inline login step
 * and the full-screen onboarding render identical lists. Nav/filter come from
 * `keys/overlay.ts`.
 *
 * The `:theme` picker previews live: moving the highlight live-swaps the active
 * theme (`keys/overlay.ts`), recolouring the real conversation *above* this sheet
 * — the authentic preview (your own session), so no canned sample panel is needed
 * here. (Onboarding has no panes behind it and shows a `ThemePreview` instead.)
 */
export const SelectList = (props: { state: SelectState<unknown> }) => {
  const s = () => props.state
  return (
    <Sheet title={s().title} width={SHEET_WIDTH}>
      <SelectBody
        state={s()}
        labelBudget={SHEET_RULE - 2}
        footer={[
          { key: "↑/↓", label: "move" },
          { key: "type", label: "filter" },
          { key: "↵", label: "select" },
          { key: "esc", label: "cancel" },
        ]}
      />
    </Sheet>
  )
}
