import { createSignal, type Accessor } from "solid-js"
import type { SessionStats, SidePaneState } from "../presentation/sidePane.js"

/**
 * Side-pane slice: the whole `SidePaneState` (activity tree + stats + files +
 * skills/instructions + the context viewer) as one signal, mutated through the
 * pure reducers in `presentation/sidePane.ts`, plus the spinner frame for running
 * nodes. `stats`/`setStats` are a narrow window onto `SidePaneState.stats` — the
 * single source for token/usage display that both the status bar and the Activity
 * header read, so the numbers can't drift.
 */
export interface SideSlice {
  readonly sidePane: Accessor<SidePaneState>
  /** Functional update of the side-pane state (reducers from `presentation/sidePane.ts`). */
  readonly setSidePane: (fn: (s: SidePaneState) => SidePaneState) => void
  /** The session stats — single source for the token/usage readouts. */
  readonly stats: Accessor<SessionStats>
  /** Functional update of the session stats (e.g. `accumulateUsage`). */
  readonly setStats: (fn: (s: SessionStats) => SessionStats) => void
  /** Spinner animation frame for running tree nodes. */
  readonly spinner: Accessor<number>
  /** Advance the spinner (driven by a scoped ticker while busy). */
  readonly tickSpinner: () => void
}

export const createSideSlice = (initial: SidePaneState): SideSlice => {
  const [sidePane, setSidePaneSig] = createSignal<SidePaneState>(initial)
  const [spinner, setSpinner] = createSignal(0)

  return {
    sidePane,
    setSidePane: (fn) => setSidePaneSig((s) => fn(s)),
    stats: () => sidePane().stats,
    setStats: (fn) => setSidePaneSig((s) => ({ ...s, stats: fn(s.stats) })),
    spinner,
    tickSpinner: () => setSpinner((n) => (n + 1) % 1_000_000),
  }
}
