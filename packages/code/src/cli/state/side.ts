import { createMemo, createSignal, type Accessor } from "solid-js"
import {
  splitSidePane,
  type SessionStats,
  type SidePaneNav,
  type SidePaneProjection,
  type SidePaneState,
} from "../presentation/sidePane.js"

/**
 * Side-pane slice, **split by writer** so the wrong write is unrepresentable:
 *
 *  - `projection` ("what to show": tree · stats · files · skills · context) is
 *    written ONLY through `setProjection` — whose updater sees a
 *    `SidePaneProjection` with no cursor/fold fields, so the event pump literally
 *    can't move the cursor.
 *  - `nav` ("where the cursor is / folds / selection") is written ONLY through
 *    `setNav` — whose updater sees a `SidePaneNav` with no tree/stats, so a
 *    keystroke can't clobber the live projection.
 *
 * `sidePane()` is a `createMemo` merge of the two, so the view components read
 * one combined `SidePaneState` exactly as before. `stats`/`setStats` are a narrow
 * window onto `projection.stats` (the single source for the token readouts).
 */
export interface SideSlice {
  readonly sidePane: Accessor<SidePaneState>
  readonly projection: Accessor<SidePaneProjection>
  readonly setProjection: (fn: (p: SidePaneProjection) => SidePaneProjection) => void
  readonly nav: Accessor<SidePaneNav>
  readonly setNav: (fn: (n: SidePaneNav) => SidePaneNav) => void
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
  const split = splitSidePane(initial)
  const [projection, setProjectionSig] = createSignal<SidePaneProjection>(split.projection)
  const [nav, setNavSig] = createSignal<SidePaneNav>(split.nav)
  const [spinner, setSpinner] = createSignal(0)

  const sidePane = createMemo<SidePaneState>(() => ({ ...projection(), ...nav() }))

  return {
    sidePane,
    projection,
    setProjection: (fn) => setProjectionSig((p) => fn(p)),
    nav,
    setNav: (fn) => setNavSig((n) => fn(n)),
    stats: () => projection().stats,
    setStats: (fn) => setProjectionSig((p) => ({ ...p, stats: fn(p.stats) })),
    spinner,
    tickSpinner: () => setSpinner((n) => (n + 1) % 1_000_000),
  }
}
