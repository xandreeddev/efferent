import { emptyTree, type ExecutionTree } from "./executionTree.js"
import {
  archivedTurnRanges,
  buildContextRowsData,
  type ContextRowData,
  type ContextSegment,
  handoffOwningTurn,
} from "./contextView.js"

export interface SidePaneInstruction {
  readonly path: string
  readonly scope: string
}

/** One file touched this session, with its running diffstat. */
export interface FileChange {
  readonly path: string
  readonly added: number
  readonly removed: number
}

/**
 * Accumulate one file's diffstat into the files-changed list: sum into the
 * existing row for that path, or append a new one. Pure find-or-append, so the
 * pump's `tool_call_end` stays a one-liner.
 */
export const mergeFileChange = (
  files: ReadonlyArray<FileChange>,
  change: FileChange,
): ReadonlyArray<FileChange> => {
  if (!files.some((f) => f.path === change.path)) return [...files, change]
  return files.map((f) =>
    f.path === change.path
      ? { path: f.path, added: f.added + change.added, removed: f.removed + change.removed }
      : f,
  )
}

/** At-a-glance session counters surfaced in the Activity header. */
export interface SessionStats {
  /** Current context size (last turn's input tokens). */
  readonly inputTokens: number
  /** Cumulative output tokens generated this session. */
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens: number
  readonly contextWindow: number
  readonly turns: number
  /** Session start (ms) for the elapsed readout; 0 = not started. */
  readonly startedAt: number
}

export const emptyStats: SessionStats = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  contextWindow: 0,
  turns: 0,
  startedAt: 0,
}

/** One turn's token usage, as carried by the agent's `assistant_message`. */
export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly totalTokens: number
  readonly cacheReadTokens: number
}

/**
 * Fold one turn's usage into the running session stats — the **single** place
 * stats accumulate (status bar + Activity both read the result). `inputTokens`/
 * `cacheReadTokens` are the latest turn's context size (replaced each turn);
 * `outputTokens`/`totalTokens` accumulate; `turns` +1. `contextWindow` and
 * `startedAt` are preserved.
 */
export const accumulateUsage = (s: SessionStats, u: TokenUsage): SessionStats => ({
  ...s,
  inputTokens: u.inputTokens,
  cacheReadTokens: u.cacheReadTokens,
  outputTokens: s.outputTokens + u.outputTokens,
  totalTokens: s.totalTokens + u.totalTokens,
  turns: s.turns + 1,
})

/**
 * **Projection** — *what the side pane shows*. Written only by the event pump as
 * the agent runs (the execution tree, stats, files, skills/instructions) and by
 * the data actions that rebuild the context segments. Carries no cursor/fold/
 * selection — that's {@link SidePaneNav}. Splitting the two means a projection
 * write *cannot* express a cursor move (the field isn't here), so the pump can't
 * scribble nav state by accident.
 */
export interface SidePaneProjection {
  readonly tree: ExecutionTree
  readonly skillsLoaded: ReadonlyArray<string>
  readonly instructions: ReadonlyArray<SidePaneInstruction>
  /** At-a-glance session counters (Activity header). */
  readonly stats: SessionStats
  /** Files touched this session, with running diffstat (Activity "files" section). */
  readonly filesChanged: ReadonlyArray<FileChange>
  /** Context-viewer segments (built from list + checkpoints); shown when view==="context". */
  readonly context?: ReadonlyArray<ContextSegment>
}

/**
 * **Nav** — *where the cursor is / what's folded or selected*. Written only by
 * keystrokes (the `keys/` dispatch). Carries no tree/stats/files, so a nav write
 * can't clobber the live projection. The reducers below take `(nav, projection)`
 * and return a new `nav`: they *read* the projection (the context segments) to
 * compute rows, but only ever *write* nav.
 */
export interface SidePaneNav {
  /** Which view the side pane shows: the live agent stack, or the context viewer. */
  readonly view: "stack" | "context"
  /** Context-tree cursor: index into the navigable rows. */
  readonly contextCursor: number
  /** Folded context-tree segment/turn ids. */
  readonly contextCollapsed: ReadonlySet<string>
  /** Selected turn indices — the units picked to build a new session. */
  readonly contextSelected: ReadonlySet<number>
  /** Selected handoff indices — each seeds the build with its summary alone. */
  readonly contextHandoffSelected: ReadonlySet<number>
  /** Folded Activity fold ids: section names + tree containers ("node:<id>"). */
  readonly stackCollapsed: ReadonlySet<string>
  /** Activity (stack) view cursor: index into its navigable rows. */
  readonly stackCursor: number
}

/** The merged view both halves compose to — what the components read (the side
 *  slice exposes a `createMemo` over `projection ⊕ nav` so renderers are untouched). */
export type SidePaneState = SidePaneProjection & SidePaneNav

export const emptyProjection: SidePaneProjection = {
  tree: emptyTree,
  skillsLoaded: [],
  instructions: [],
  stats: emptyStats,
  filesChanged: [],
}

export const emptyNav: SidePaneNav = {
  view: "stack",
  contextCursor: 0,
  contextCollapsed: new Set(),
  contextSelected: new Set(),
  contextHandoffSelected: new Set(),
  stackCollapsed: new Set(["files", "skills", "instructions"]),
  stackCursor: 0,
}

export const emptySidePane: SidePaneState = { ...emptyProjection, ...emptyNav }

/** Split a merged side-pane state into its projection + nav halves — lets the
 *  side slice seed its two signals from one initial `SidePaneState`. */
export const splitSidePane = (
  s: SidePaneState,
): { projection: SidePaneProjection; nav: SidePaneNav } => ({
  projection: {
    tree: s.tree,
    skillsLoaded: s.skillsLoaded,
    instructions: s.instructions,
    stats: s.stats,
    filesChanged: s.filesChanged,
    ...(s.context !== undefined ? { context: s.context } : {}),
  },
  nav: {
    view: s.view,
    contextCursor: s.contextCursor,
    contextCollapsed: s.contextCollapsed,
    contextSelected: s.contextSelected,
    contextHandoffSelected: s.contextHandoffSelected,
    stackCollapsed: s.stackCollapsed,
    stackCursor: s.stackCursor,
  },
})

// --- context-tree navigation (pure; the driver re-derives rows each call) ---

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(n, hi))

export const contextRows = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
): ReadonlyArray<ContextRowData> =>
  buildContextRowsData(
    projection.context ?? [],
    nav.contextCollapsed,
    nav.contextSelected,
    nav.contextHandoffSelected,
  )

export const sideCursorMove = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
  delta: number,
): SidePaneNav => {
  const n = contextRows(nav, projection).length
  if (n === 0) return nav
  return { ...nav, contextCursor: clamp(nav.contextCursor + delta, 0, n - 1) }
}
export const sideCursorToTop = (nav: SidePaneNav): SidePaneNav => ({
  ...nav,
  contextCursor: 0,
})
export const sideCursorToEnd = (nav: SidePaneNav, projection: SidePaneProjection): SidePaneNav => {
  const n = contextRows(nav, projection).length
  return { ...nav, contextCursor: Math.max(0, n - 1) }
}
/** Fold/unfold the segment under the cursor (no-op on non-collapsible rows). */
export const sideToggleNode = (nav: SidePaneNav, projection: SidePaneProjection): SidePaneNav => {
  const rows = contextRows(nav, projection)
  const row = rows[clamp(nav.contextCursor, 0, Math.max(0, rows.length - 1))]
  if (row === undefined || !row.collapsible || row.groupId === undefined) return nav
  const next = new Set(nav.contextCollapsed)
  if (next.has(row.groupId)) next.delete(row.groupId)
  else next.add(row.groupId)
  return { ...nav, contextCollapsed: next }
}
/** The row under the cursor (for the driver's Enter = jump-or-fold decision). */
export const sideCurrentRow = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
): ContextRowData | undefined => {
  const rows = contextRows(nav, projection)
  return rows[clamp(nav.contextCursor, 0, Math.max(0, rows.length - 1))]
}

/**
 * Toggle selection of the unit under the cursor: a `turn` row (its messages) or
 * an archived `handoff` segment row (its summary). A handoff and its own inner
 * turns are mutually exclusive — selecting one clears the other for that handoff
 * (summary OR raw messages, never both). No-op on other rows.
 */
export const sideToggleSelect = (nav: SidePaneNav, projection: SidePaneProjection): SidePaneNav => {
  const row = sideCurrentRow(nav, projection)
  const segments = projection.context ?? []

  // Archived handoff: select its summary; drop its inner turns.
  if (row?.kind === "segment" && row.handoffIndex !== undefined) {
    const handoffs = new Set(nav.contextHandoffSelected)
    const turns = new Set(nav.contextSelected)
    if (handoffs.has(row.handoffIndex)) {
      handoffs.delete(row.handoffIndex)
    } else {
      handoffs.add(row.handoffIndex)
      const range = archivedTurnRanges(segments).get(row.handoffIndex)
      if (range !== undefined) {
        for (let i = range.start; i < range.start + range.count; i++) turns.delete(i)
      }
    }
    return { ...nav, contextHandoffSelected: handoffs, contextSelected: turns }
  }

  // Turn: select its messages; if it belongs to a selected handoff, drop that handoff.
  if (row?.kind === "turn" && row.turnIndex !== undefined) {
    const turns = new Set(nav.contextSelected)
    const handoffs = new Set(nav.contextHandoffSelected)
    if (turns.has(row.turnIndex)) {
      turns.delete(row.turnIndex)
    } else {
      turns.add(row.turnIndex)
      const owner = handoffOwningTurn(segments, row.turnIndex)
      if (owner !== undefined) handoffs.delete(owner)
    }
    return { ...nav, contextSelected: turns, contextHandoffSelected: handoffs }
  }

  return nav
}

