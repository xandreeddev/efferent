import { glyph, tokens } from "../../theme.js"
import { displayValue } from "../../presentation/promptBox.js"
import type { PromptState } from "../../presentation/promptBox.js"

/**
 * A single-line text-entry surface for a `PromptState`: title, instruction,
 * then the (possibly bullet-masked) value with a block cursor. The key
 * handler owns the input; this only renders.
 */
export const PromptBody = (props: { prompt: PromptState }) => (
  <box flexDirection="column" flexShrink={0}>
    <text fg={tokens.text.default} wrapMode="none">{props.prompt.title}</text>
    <box height={1} />
    <box flexDirection="row">
      <text fg={tokens.text.dim} wrapMode="none">{`  ${props.prompt.prompt}: `}</text>
      <text fg={tokens.text.bright} wrapMode="none">{displayValue(props.prompt)}</text>
      <text fg={tokens.marker.cursor}>{glyph.cursorBlock}</text>
    </box>
  </box>
)
