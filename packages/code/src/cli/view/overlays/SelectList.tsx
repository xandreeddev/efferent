import type { SelectState } from "../../presentation/selectBox.js"
import { Modal, MODAL_RULE, MODAL_WIDTH, SelectBody } from "../ui/index.js"

/**
 * A centered, navigable list overlay — the OpenTUI analogue of `renderSelectBox`,
 * driving the same pure `SelectState` (`presentation/selectBox.ts`). The list
 * itself is the shared {@link SelectBody} primitive; this component only supplies
 * the `Modal` chrome (title + border + surface), so the modal and the full-screen
 * onboarding render identical lists. Nav/filter come from `keys/overlay.ts`.
 *
 * The `:theme` picker previews live: moving the highlight live-swaps the active
 * theme (`keys/overlay.ts`), recolouring the real panes *behind* this modal — the
 * authentic preview (your own session), so no canned sample panel is needed here.
 * (Onboarding has no panes behind it and shows a `ThemePreview` panel instead.)
 */
export const SelectList = (props: { state: SelectState<unknown> }) => {
  const s = () => props.state
  return (
    <Modal title={s().title} width={MODAL_WIDTH}>
      <SelectBody
        state={s()}
        labelBudget={MODAL_RULE - 2}
        footer={[
          { key: "↑/↓", label: "move" },
          { key: "type", label: "filter" },
          { key: "↵", label: "select" },
          { key: "esc", label: "cancel" },
        ]}
      />
    </Modal>
  )
}
