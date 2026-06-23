import { Show } from "solid-js"
import { formatElapsed } from "../../presentation/agentState.js"
import { glyph, tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The running loader — the ONE agy heartbeat, directly above the input fence
 * while a turn is in flight: `⣻ thinking 4s`. Deliberately quiet — a spinner, a
 * phase word, and elapsed, nothing more. It does NOT name the current tool: the
 * conversation rail on the left already shows each tool pill live (that's the
 * agent's status), so echoing the tool here would just be noise. `working` when
 * only the background fleet runs (the fleet's detail lives on the right). Hidden
 * when idle.
 *
 * Bottom-chrome rhythm (agy): **loader → pending `▸` messages → input fence**.
 */
export const RunningLoader = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const st = () => store.agentState()
  const phaseActive = () => st().phase !== "idle"
  const fleetRunning = () => st().fleet.length > 0
  // "Working" covers the async case: the lead turn can be idle while the
  // background fleet keeps going — don't go silent then.
  const active = () => phaseActive() || fleetRunning()
  // Phase WORD only — never the tool label (the rail owns the tool).
  const label = () => (phaseActive() ? "thinking" : "working")
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
          {label()}
        </text>
        <Show when={elapsed().length > 0}>
          <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>{` ${elapsed()}`}</text>
        </Show>
      </box>
    </Show>
  )
}
