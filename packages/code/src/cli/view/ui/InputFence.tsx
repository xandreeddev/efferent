import { Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { glyph, tokens } from "../../state/theme.js"

/** What the composer is doing — drives the prompt-glyph colour so entering a `:`
 *  command or a `/` search visibly "replaces the caret" (agy contextual menu). */
export type ComposerMode = "message" | "command" | "search"

/**
 * The composer fence (agy-style): a full-width `─` rule, a `> ` prompt row whose
 * children are the textarea, then a closing rule. Replaces the bordered input
 * `Pane` — agy has no input box, just rules around a prompt. The rules tint to
 * the input accent when focused (keeping efferent's per-pane focus cue inside
 * agy's borderless form) and dim otherwise.
 *
 * The `> ` prompt glyph **recolours by `mode`** so the caret itself signals which
 * menu is live (this is "the command palette replaces the caret"): message →
 * the input accent (green), `:command` → the side/overlay accent (magenta, the
 * menu world), `/search` → the conversation accent (cyan, where the search lands).
 * The full-width rules stay the stable focus accent so only the small caret
 * changes — a crisp cue, no flashing. `suffix` is an optional dim label shown
 * above the fence (e.g. `→ agent: adapters` while a node preview routes the
 * composer to a sub-agent).
 */
export const InputFence = (props: {
  focused: boolean
  mode?: ComposerMode | undefined
  suffix?: string | undefined
  children: JSX.Element
}) => {
  const dims = useTerminalDimensions()
  const ruleColor = () => (props.focused ? tokens.accent.input : tokens.border.unfocused)
  const promptColor = () => {
    if (!props.focused) return tokens.border.unfocused
    switch (props.mode) {
      case "command":
        return tokens.accent.side
      case "search":
        return tokens.accent.conversation
      default:
        return tokens.accent.input
    }
  }
  const rule = () => "─".repeat(Math.max(1, dims().width))
  return (
    <box flexDirection="column" flexShrink={0}>
      <Show when={props.suffix !== undefined}>
        <text fg={tokens.text.dim} wrapMode="none">
          {props.suffix}
        </text>
      </Show>
      <text fg={ruleColor()} wrapMode="none">
        {rule()}
      </text>
      <box flexDirection="row">
        <text fg={promptColor()} flexShrink={0}>{`${glyph.prompt} `}</text>
        {props.children}
      </box>
      <text fg={ruleColor()} wrapMode="none">
        {rule()}
      </text>
    </box>
  )
}
