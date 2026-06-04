import { theme } from "../../theme.js"

/**
 * A centered single-line text-entry overlay — the OpenTUI analogue of
 * `renderPromptBox`, driving the pure `PromptState` (`tui/promptBox.ts`). When
 * `mask` is set the value renders as bullets (API keys never show on screen /
 * in a screenshot — OPSEC). Nav/append/backspace come from `keys/overlay.ts`.
 */
export const PromptBox = (props: {
  title: string
  prompt: string
  value: string
  mask: boolean
}) => {
  const shown = () => (props.mask ? "•".repeat(props.value.length) : props.value)
  return (
    <box
      flexDirection="column"
      border
      title={` ${props.title} `}
      borderColor={theme.accent.side}
      backgroundColor={theme.overlayBg}
      width={72}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.gray} wrapMode="none">
        {props.prompt}
      </text>
      <text fg={theme.dim}>{"─".repeat(68)}</text>
      <box flexDirection="row">
        <text fg={theme.text} wrapMode="none">
          {shown()}
        </text>
        <text fg={theme.select}>█</text>
      </box>
      <text fg={theme.dim}>{"─".repeat(68)}</text>
      <text fg={theme.gray}>↵ submit · esc back / cancel</text>
    </box>
  )
}
