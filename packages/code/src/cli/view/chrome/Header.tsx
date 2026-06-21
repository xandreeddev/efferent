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
  // An agent is paused waiting for the human to answer a bash approval — the one
  // state that LOOKS like a hang but isn't. Surface it loudly so it's obvious
  // the agent is waiting on YOU (the sheet is in the bottom chrome).
  const approvalPending = () => store.overlay().kind === "approval"
  const phaseActive = () => st().phase !== "idle"
  const fleetRunning = () => st().fleet.length > 0
  // "Working" covers the async case too: the lead turn can be idle while the
  // background fleet keeps going — so don't read "idle" when agents are live.
  const active = () => phaseActive() || fleetRunning()
  const label = () => (phaseActive() ? agentStateLabel(st()) : "fleet working")
  const spin = () => glyph.spinner[store.spinner() % glyph.spinner.length]
  const elapsed = () => {
    // The spinner signal doubles as the clock tick — it advances while busy,
    // which is exactly when the elapsed readout needs to move.
    void store.spinner()
    return phaseActive() && st().since > 0 ? fmtElapsed(Date.now() - st().since) : ""
  }
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
      <Show
        when={!approvalPending()}
        fallback={
          <text fg={tokens.state.error} wrapMode="none" flexShrink={0}>
            {`  ${glyph.idleDot} approval needed — answer below`}
          </text>
        }
      >
        <Show
          when={active()}
          fallback={<text fg={tokens.text.dim} flexShrink={0}>{`  ${glyph.idleDot} idle`}</text>}
        >
          <text fg={tokens.state.running} flexShrink={0}>{`  ${spin()} `}</text>
          <text fg={tokens.text.default} wrapMode="none" flexShrink={0}>
            {label()}
          </text>
          <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>{` ${elapsed()}`}</text>
        </Show>
        <Show when={fleet()}>
          <text fg={tokens.accent.side} wrapMode="none">{`  ${glyph.fleet} ${fleet()}`}</text>
        </Show>
      </Show>
    </box>
  )
}
