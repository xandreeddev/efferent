import { Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { glyph, tokens } from "../../state/theme.js"

/**
 * The composer fence (agy-style): a full-width `─` rule, a `> ` prompt row whose
 * children are the textarea, then a closing rule. Replaces the bordered input
 * `Pane` — agy has no input box, just rules around a prompt. The rules tint to
 * the input accent when focused (keeping efferent's per-pane focus cue inside
 * agy's borderless form) and dim otherwise. `suffix` is an optional dim label
 * shown above the fence (e.g. `→ agent: adapters` while a node preview routes the
 * composer to a sub-agent).
 */
export const InputFence = (props: {
  focused: boolean
  suffix?: string | undefined
  children: JSX.Element
}) => {
  const dims = useTerminalDimensions()
  const color = () => (props.focused ? tokens.accent.input : tokens.border.unfocused)
  const rule = () => "─".repeat(Math.max(1, dims().width))
  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={props.suffix !== undefined}>
        <text fg={tokens.text.dim} wrapMode="none">
          {props.suffix}
        </text>
      </Show>
      <text fg={color()} wrapMode="none">
        {rule()}
      </text>
      <box flexDirection="row">
        <text fg={color()} flexShrink={0}>{`${glyph.prompt} `}</text>
        {props.children}
      </box>
      <text fg={color()} wrapMode="none">
        {rule()}
      </text>
    </box>
  )
}
