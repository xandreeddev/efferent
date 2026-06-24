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

  // The wordmark brands the bin: the master assistant is `▌efferent`; the
  // focused coder appends ` ⟩ code` so the two are unmistakable at a glance.
  const wordmark = () =>
    props.ctx.variant === "code"
      ? `${glyph.wordmark}efferent ${glyph.codeBrand} code`
      : `${glyph.wordmark}efferent`

  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={tokens.accent.conversation} flexShrink={0}>
        {wordmark()}
      </text>
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
