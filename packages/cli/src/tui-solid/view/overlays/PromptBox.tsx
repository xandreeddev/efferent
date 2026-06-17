import { glyph, tokens } from "../../state/theme.js"
import { Cursor, Modal, MODAL_WIDTH } from "../ui/index.js"

/**
 * A single-line text-entry menu, driving the pure `PromptState`
 * (`presentation/promptBox.ts`) — agy-style: borderless, left-aligned, a `>`
 * prompt before the value. When `mask` is set the value renders as bullets (API
 * keys never show on screen / in a screenshot — OPSEC). Nav/append/backspace
 * come from `keys/overlay.ts`; the shared `Modal` owns the panel chrome.
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
        {`  ${props.prompt}`}
      </text>
      <text> </text>
      <box flexDirection="row">
        <text fg={tokens.accent.input} flexShrink={0}>{`${glyph.prompt} `}</text>
        <text fg={tokens.text.default} wrapMode="none">
          {shown()}
        </text>
        <Cursor />
      </box>
      <text> </text>
      <text fg={tokens.text.muted}>{"  enter Submit · esc Back / Cancel"}</text>
    </Modal>
  )
}
