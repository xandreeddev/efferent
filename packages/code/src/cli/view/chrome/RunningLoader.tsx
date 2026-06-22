import { Show } from "solid-js"
import { agentStateLabel, formatElapsed } from "../../presentation/agentState.js"
import { glyph, tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The running loader (agy-style): a single spinner line that sits **directly
 * above the input fence** while a turn is in flight — `⣻  thinking 4s` — so the
 * "is it working?" cue lives where the eye already is (at the composer), not
 * only in the far-away header. It mirrors the header's live state machine
 * (spinner + phase/tool label + elapsed; `fleet working` when only the
 * background fleet runs) and is hidden when idle.
 *
 * Bottom-chrome rhythm (agy): **loader → pending `▸` messages → input fence**.
 * Render order in `App.tsx` puts this immediately above `QueuedMessages`, which
 * is itself above the `InputBox` — so a queued message drops between the loader
 * and the composer, exactly as agy does it.
 */
export const RunningLoader = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const st = () => store.agentState()
  const phaseActive = () => st().phase !== "idle"
  const fleetRunning = () => st().fleet.length > 0
  // "Working" covers the async case: the lead turn can be idle while the
  // background fleet keeps going — don't go silent then.
  const active = () => phaseActive() || fleetRunning()
  const label = () => (phaseActive() ? agentStateLabel(st()) : "fleet working")
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
