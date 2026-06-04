import { tokens } from "../../presentation/theme/index.js"
import { Cursor, Modal, MODAL_RULE, MODAL_WIDTH, Rule } from "../ui/index.js"

/**
 * A centered single-line text-entry overlay, driving the pure `PromptState`
 * (`presentation/promptBox.ts`). When `mask` is set the value renders as bullets
 * (API keys never show on screen / in a screenshot — OPSEC). Nav/append/backspace
 * come from `keys/overlay.ts`; the shared `Modal` owns the chrome.
 */
export const PromptBox = (props: {
  title: string
  prompt: string
  value: string
  mask: boolean
}) => {
  const shown = () => (props.mask ? "•".repeat(props.value.length) : props.value)
  return (
    <Modal title={props.title} width={MODAL_WIDTH}>
      <text fg={tokens.text.muted} wrapMode="none">
        {props.prompt}
      </text>
      <Rule width={MODAL_RULE} />
      <box flexDirection="row">
        <text fg={tokens.text.default} wrapMode="none">
          {shown()}
        </text>
        <Cursor />
      </box>
      <Rule width={MODAL_RULE} />
      <text fg={tokens.text.muted}>↵ submit · esc back / cancel</text>
    </Modal>
  )
}
