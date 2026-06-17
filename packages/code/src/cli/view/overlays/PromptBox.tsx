import { Modal, MODAL_WIDTH, PromptBody } from "../ui/index.js"

/**
 * A centered single-line text-entry overlay, driving the pure `PromptState`
 * (`presentation/promptBox.ts`). The input itself is the shared {@link PromptBody}
 * primitive; this component only supplies the `Modal` chrome (title + border +
 * surface), so the modal and the full-screen onboarding render identical
 * prompts. When `mask` is set the value renders as bullets (API keys never show
 * on screen / in a screenshot — OPSEC). Nav/append/backspace come from
 * `keys/overlay.ts`.
 */
export const PromptBox = (props: {
  title: string
  prompt: string
  value: string
  mask: boolean
}) => (
  <Modal title={props.title} width={MODAL_WIDTH}>
    <PromptBody
      prompt={props.prompt}
      value={props.value}
      mask={props.mask}
      footer="↵ submit · esc back / cancel"
    />
  </Modal>
)
