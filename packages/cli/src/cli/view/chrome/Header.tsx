import { Show } from "solid-js"
import { fleetLabel } from "../../presentation/agentState.js"
import { glyph, tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The header bar — agy two-zone, mirroring the panes: the **wordmark** on the
 * LEFT (over the conversation) and the **fleet status** on the RIGHT (over the
 * fleet tree). It deliberately does NOT show the agent's own spinner/phase/tool:
 * that's the bottom-chrome `RunningLoader` (above the input, where the eye is)
 * plus the live tool pills in the conversation rail. Keeping it here too was the
 * confusing duplication. The one exception is a **bash approval** — a pause that
 * looks like a hang but is waiting on YOU — surfaced loudly. Reads `agentState`
 * (pure, event-fed).
 */
export const Header = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const st = () => store.agentState()
  const approvalPending = () => store.overlay().kind === "approval"
  const fleet = () => fleetLabel(st())

  // Just the wordmark — no bin/variant suffix. The old ` ⟩ code` leaked an
  // internal driver name and now collides with the `code` model role.
  const wordmark = () => `${glyph.wordmark}efferent`

  const modeLabel = () => {
    if (store.mode() === "insert" && store.focus() === "input") return "[INSERT]"
    if (store.mode() === "normal") return "[NOR]"
    if (store.mode() === "visual") return "[VIS]"
    return undefined
  }

  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={tokens.accent.conversation} flexShrink={0}>
        {wordmark()}
      </text>
      <Show when={modeLabel()}>
        {(label) => (
          <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>
            {` ${label()}`}
          </text>
        )}
      </Show>
      <Show when={approvalPending()}>
        <text fg={tokens.state.error} wrapMode="none" flexShrink={0}>
          {`  ${glyph.idleDot} approval needed — answer below`}
        </text>
      </Show>
      {/* Spacer pushes the fleet status to the RIGHT, over the fleet-tree pane. */}
      <box flexGrow={1} />
      <Show when={fleet()}>
        <text fg={tokens.accent.side} wrapMode="none" flexShrink={0}>
          {`${glyph.fleet} ${fleet()} `}
        </text>
      </Show>
    </box>
  )
}
