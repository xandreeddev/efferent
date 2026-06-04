import { createSignal, type Accessor } from "solid-js"
import type { SidePaneState } from "../../tui/sidePane.js"

/**
 * Side-pane slice: the whole `SidePaneState` (activity tree + stats + files +
 * skills/instructions + the context viewer) as one signal, mutated through the
 * pure reducers in `tui/sidePane.ts`, plus the spinner frame for running nodes.
 */
export interface SideSlice {
  readonly sidePane: Accessor<SidePaneState>
  /** Functional update of the side-pane state (reducers from `tui/sidePane.ts`). */
  readonly setSidePane: (fn: (s: SidePaneState) => SidePaneState) => void
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
    spinner,
    tickSpinner: () => setSpinner((n) => (n + 1) % 1_000_000),
  }
}
