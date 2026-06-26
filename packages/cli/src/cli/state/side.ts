import { createMemo, createSignal, type Accessor } from "solid-js"
import {
  splitSidePane,
  type SessionStats,
  type SidePaneNav,
  type SidePaneProjection,
  type SidePaneState,
  type TreeData,
} from "../presentation/sidePane.js"
import { type ExecutionTree } from "../presentation/executionTree.js"

/**
 * Side-pane slice, **fine-grained by write-frequency** so an update notifies
 * only the consumers that care. The pure `SidePaneProjection` (L1) bundles ten
 * concerns, but they're written at wildly different rates — the execution
 * `tree` on EVERY tool/turn/sub-agent event, `stats` per turn, the fleet
 * `treeData` only at refresh boundaries, the rest rarely. Holding them in ONE
 * signal made a per-event `tree` write re-notify the status bar (`stats`) and
 * the fleet tree (`treeData`) for nothing. So the slice keeps them in SEPARATE
 * signals:
 *
 *  - `executionTree` — the activity/run tree; hot (every event).
 *  - `stats` — session counters; the status bar's sole input (per turn).
 *  - `treeData` — fleet nodes/sessions/ref; the fleet tree's input (per refresh).
 *  - `projection` (the REST) — plan · filesChanged · skills · instructions ·
 *    context; rare writes. (The `setProjection` reducer sees this rest shape.)
 *  - `nav` — cursor/folds/selection; keystroke-only.
 *
 * `projection()` / `sidePane()` are `createMemo` REASSEMBLIES of the full pure
 * shapes — for the pure flatteners and the imperative (non-reactive) readers
 * (the keymap, search, session actions). **Reactive consumers must read the
 * NARROW accessors** (`stats()`, `executionTree()`, `treeData()`) so they
 * subscribe only to their concern; reading `sidePane()` reactively would
 * re-couple them to every event. (Guarded by a test in `side.test.ts`.)
 */

/** The projection fields with their own signals carved out — what `setProjection`
 *  and the rest-reassembly operate on. */
type ProjRest = Omit<
  SidePaneProjection,
  "tree" | "stats" | "treeNodes" | "sessions" | "treeWorkspaceRef"
>

const restOf = (p: SidePaneProjection): ProjRest => ({
  skillsLoaded: p.skillsLoaded,
  instructions: p.instructions,
  plan: p.plan,
  filesChanged: p.filesChanged,
  ...(p.context !== undefined ? { context: p.context } : {}),
})

const treeDataOf = (p: SidePaneProjection): TreeData => ({
  ...(p.treeNodes !== undefined ? { treeNodes: p.treeNodes } : {}),
  ...(p.sessions !== undefined ? { sessions: p.sessions } : {}),
  ...(p.treeWorkspaceRef !== undefined ? { treeWorkspaceRef: p.treeWorkspaceRef } : {}),
})

export interface SideSlice {
  /** Full merged state (projection ⊕ nav) — for pure flatteners + imperative
   *  readers ONLY. Reactive consumers should read the narrow accessors. */
  readonly sidePane: Accessor<SidePaneState>
  /** Full reassembled projection — same caveat as `sidePane`. */
  readonly projection: Accessor<SidePaneProjection>
  /** The hot execution/run tree — the activity + live-feed consumers' input. */
  readonly executionTree: Accessor<ExecutionTree>
  /** The fleet tree's source data (nodes/sessions/ref) — the fleet-tree input. */
  readonly treeData: Accessor<TreeData>
  /** Replace the execution tree (per-event writes from the pump). */
  readonly setTree: (fn: (t: ExecutionTree) => ExecutionTree) => void
  /** Merge into the fleet tree data (refreshNav writes nodes/sessions/ref). */
  readonly setTreeData: (fn: (d: TreeData) => TreeData) => void
  /** The rare-write rest of the projection (plan/files/skills/instructions/context). */
  readonly setProjection: (fn: (p: ProjRest) => ProjRest) => void
  /** Replace the WHOLE projection at once (context switch / resume rebuild) —
   *  fans a full `SidePaneProjection` out across the per-concern signals. */
  readonly replaceProjection: (full: SidePaneProjection) => void
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
  const [executionTree, setExecTreeSig] = createSignal<ExecutionTree>(split.projection.tree)
  const [stats, setStatsSig] = createSignal<SessionStats>(split.projection.stats)
  const [treeData, setTreeDataSig] = createSignal<TreeData>(treeDataOf(split.projection))
  const [projRest, setProjRestSig] = createSignal<ProjRest>(restOf(split.projection))
  const [nav, setNavSig] = createSignal<SidePaneNav>(split.nav)
  const [spinner, setSpinner] = createSignal(0)

  // Reassemblies for pure flatteners + imperative readers. They re-evaluate when
  // ANY part changes (that's fine — only NON-reactive callers read them).
  const projection = createMemo<SidePaneProjection>(() => ({
    ...projRest(),
    tree: executionTree(),
    stats: stats(),
    ...treeData(),
  }))
  const sidePane = createMemo<SidePaneState>(() => ({ ...projection(), ...nav() }))

  return {
    sidePane,
    projection,
    executionTree,
    treeData,
    setTree: (fn) => setExecTreeSig((t) => fn(t)),
    setTreeData: (fn) => setTreeDataSig((d) => fn(d)),
    setProjection: (fn) => setProjRestSig((p) => fn(p)),
    replaceProjection: (full) => {
      setExecTreeSig(() => full.tree)
      setStatsSig(() => full.stats)
      setTreeDataSig(() => treeDataOf(full))
      setProjRestSig(() => restOf(full))
    },
    nav,
    setNav: (fn) => setNavSig((n) => fn(n)),
    stats,
    setStats: (fn) => setStatsSig((s) => fn(s)),
    spinner,
    tickSpinner: () => setSpinner((n) => (n + 1) % 1_000_000),
  }
}
