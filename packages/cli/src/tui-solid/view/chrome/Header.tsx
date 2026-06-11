import { Show } from "solid-js"
import { agentStateLabel, fleetLabel } from "../../presentation/agentState.js"
import { glyph, tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

const fmtElapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m${s - m * 60}s`
}

/**
 * The header bar — the agent's face. One always-visible line answering the two
 * questions that matter while anything runs: *what is the agent doing right
 * now* (the live state machine: spinner + phase/tool + elapsed, and the fleet
 * chip when sub-agents work) and *which session is this* (the generated title,
 * right-aligned). Reads `agentState` (pure, event-fed) — never infers from
 * `busy` or scrapes other panes.
 */
export const Header = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const st = () => store.agentState()
  const running = () => st().phase !== "idle"
  const spin = () => glyph.spinner[store.spinner() % glyph.spinner.length]
  const elapsed = () => {
    // The spinner signal doubles as the clock tick — it advances while busy,
    // which is exactly when the elapsed readout needs to move.
    void store.spinner()
    return st().since > 0 ? fmtElapsed(Date.now() - st().since) : ""
  }
  const fleet = () => fleetLabel(st())
  const title = () =>
    store.projection().sessions?.find((c) => c.active)?.title ?? ""

  return (
    <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
      <box flexDirection="row">
        <text fg={tokens.accent.conversation} flexShrink={0}>
          {`${glyph.wordmark}efferent`}
        </text>
        <Show
          when={running()}
          fallback={<text fg={tokens.text.dim} flexShrink={0}>{`  ${glyph.idleDot} idle`}</text>}
        >
          <text fg={tokens.state.running} flexShrink={0}>{`  ${spin()} `}</text>
          <text fg={tokens.text.default} wrapMode="none" flexShrink={0}>
            {agentStateLabel(st())}
          </text>
          <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>{` ${elapsed()}`}</text>
        </Show>
        <Show when={fleet()}>
          <text fg={tokens.accent.side} wrapMode="none">{`  ${glyph.fleet} ${fleet()}`}</text>
        </Show>
      </box>
      <Show when={title().length > 0}>
        <text fg={tokens.text.muted} wrapMode="none">{title()}</text>
      </Show>
    </box>
  )
}
