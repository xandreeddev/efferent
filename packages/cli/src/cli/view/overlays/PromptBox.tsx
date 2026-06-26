import { Sheet, SHEET_WIDTH, PromptBody } from "../ui/index.js"

/**
 * A single-line text-entry step, driving the pure `PromptState`
 * (`presentation/promptBox.ts`). The input itself is the shared {@link PromptBody}
 * primitive; this only supplies the borderless {@link Sheet} chrome (title +
 * width), so the inline login step and the full-screen onboarding render identical
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
  <Sheet title={props.title} width={SHEET_WIDTH}>
    <PromptBody
      prompt={props.prompt}
      value={props.value}
      mask={props.mask}
      footer={[
        { key: "↵", label: "submit" },
        { key: "esc", label: "back / cancel" },
      ]}
    />
  </Sheet>
)
