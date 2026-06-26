import { tokens } from "../../state/theme.js"
import { Cursor, KeyHints, type KeyHint } from "./atoms.js"

/**
 * The inner body of a single-line text-entry overlay — the prompt line, the
 * (optionally masked) value with a cursor, and a footer hint — WITHOUT any
 * surrounding chrome (no `Modal`, no rules). Shared by `PromptBox` (wrapped in a
 * `Modal`) and the onboarding flow (bare, full-screen). When `mask` is set the
 * value renders as bullets (API keys never show on screen / in a screenshot).
 *
 * `prompt` is rendered by the caller when it needs richer layout (e.g. the
 * onboarding OAuth link block); pass `undefined` to omit it here.
 */
export const PromptBody = (props: {
  prompt?: string | undefined
  value: string
  mask: boolean
  footer: ReadonlyArray<KeyHint>
}) => {
  const shown = () => (props.mask ? "•".repeat(props.value.length) : props.value)
  return (
    <box flexDirection="column">
      {props.prompt !== undefined ? (
        <text fg={tokens.text.muted} wrapMode="word">
          {props.prompt}
        </text>
      ) : null}
      <box height={1} />
      <box flexDirection="row">
        <text fg={tokens.text.default} wrapMode="none">
          {shown()}
        </text>
        <Cursor />
      </box>
      <box height={1} />
      <KeyHints hints={props.footer} />
    </box>
  )
}
