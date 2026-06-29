import { Show } from "solid-js"
import { formatElapsed, loaderState } from "../../presentation/agentState.js"
import { glyph, tokens } from "../../state/theme.js"
import type { TuiContext } from "../../state/store.js"

/**
 * The running loader — the ONE agy heartbeat, directly above the input fence.
 * Two shapes (see {@link loaderState}):
 *  - the root's OWN turn in flight → `⣻ thinking 4s` (spinner + elapsed clock).
 *  - the root turn has ended but background agents run on → `⣻ waiting for 2 agents`
 *    (no elapsed — there's no single root clock for the fleet). This is the
 *    "it just works, we keep waiting" status: the loader no longer goes dead the
 *    instant the root's turn ends while the fleet is still working. The fleet
 *    tree on the right still carries each agent's live `●` + detail.
 *
 * Deliberately quiet — a spinner and a short status, nothing more. It does NOT
 * name the running tool: the conversation rail already shows each tool pill live.
 *
 * Bottom-chrome rhythm (agy): **loader → pending `▸` messages → input fence**.
 */
export const RunningLoader = (props: { ctx: TuiContext }) => {
  const { store } = props.ctx
  const ld = () => loaderState(store.agentState())
  const spin = () => glyph.spinner[store.spinner() % glyph.spinner.length]
  const elapsed = () => {
    // The spinner signal doubles as the clock tick — it advances while busy,
    // which is exactly when the elapsed readout needs to move.
    void store.spinner()
    const s = store.agentState()
    return s.since > 0 ? formatElapsed(Date.now() - s.since) : ""
  }
  return (
    <Show when={ld()}>
      {(state) => (
        <box flexDirection="row" flexShrink={0} marginTop={1}>
          <text fg={tokens.state.running} flexShrink={0}>{`${spin()}  `}</text>
          <text fg={tokens.text.default} wrapMode="none" flexShrink={0}>
            {state().label}
          </text>
          <Show when={state().showElapsed && elapsed().length > 0}>
            <text fg={tokens.text.dim} wrapMode="none" flexShrink={0}>{` ${elapsed()}`}</text>
          </Show>
        </box>
      )}
    </Show>
  )
}
