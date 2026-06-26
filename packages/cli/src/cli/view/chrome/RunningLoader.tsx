import { Show } from "solid-js"
import { formatElapsed } from "../../presentation/agentState.js"
import { glyph, tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The running loader — the ONE agy heartbeat, directly above the input fence
 * while THIS (the root / current) agent's own turn is in flight: `⣻ thinking 4s`.
 * Deliberately quiet — a spinner, a phase word, and elapsed, nothing more. It
 * does NOT name the current tool: the conversation rail on the left already
 * shows each tool pill live, so echoing the tool here would just be noise.
 *
 * It tracks the ROOT phase ONLY — never the background fleet. A sub-agent that
 * is running shows on the right (its live `●` on the fleet-tree node + the
 * node-detail tool feed); surfacing it here too read as a confusing second
 * spinner for work the loader isn't driving. So when the root turn ends but
 * background daemons keep going, the loader goes idle and the fleet tree carries
 * the running state.
 *
 * Bottom-chrome rhythm (agy): **loader → pending `▸` messages → input fence**.
 */
export const RunningLoader = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const st = () => store.agentState()
  const phaseActive = () => st().phase !== "idle"
  // Root phase only — the fleet's running state lives on the right-pane tree,
  // not in this heartbeat.
  const active = () => phaseActive()
  const label = "thinking"
  const spin = () => glyph.spinner[store.spinner() % glyph.spinner.length]
  const elapsed = () => {
    // The spinner signal doubles as the clock tick — it advances while busy,
    // which is exactly when the elapsed readout needs to move.
    void store.spinner()
    return phaseActive() && st().since > 0 ? formatElapsed(Date.now() - st().since) : ""
  }
  return (
    <Show when={active()}>
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text fg={tokens.state.running} flexShrink={0}>{`${spin()}  `}</text>
        <text fg={tokens.text.default} wrapMode="none" flexShrink={0}>
          {label}
        </text>
        <Show when={elapsed().length > 0}>
          <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>{` ${elapsed()}`}</text>
        </Show>
      </box>
    </Show>
  )
}
