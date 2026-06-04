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

export interface SidePaneState {
  readonly tree: ExecutionTree
  readonly skillsLoaded: ReadonlyArray<string>
  readonly instructions: ReadonlyArray<SidePaneInstruction>
  /** Which view the side pane shows: the live agent stack, or the context viewer. */
  readonly view: "stack" | "context"
  /** Context-viewer segments (built from list + checkpoints); shown when view==="context". */
  readonly context?: ReadonlyArray<ContextSegment>
  /** Context-tree cursor: index into the navigable rows. */
  readonly contextCursor: number
  /** Folded context-tree segment/turn ids. */
  readonly contextCollapsed: ReadonlySet<string>
  /** Selected turn indices — the units picked to build a new session. */
  readonly contextSelected: ReadonlySet<number>
  /** Selected handoff indices — each seeds the build with its summary alone. */
  readonly contextHandoffSelected: ReadonlySet<number>
  /** At-a-glance session counters (Activity header). */
  readonly stats: SessionStats
  /** Files touched this session, with running diffstat (Activity "files" section). */
  readonly filesChanged: ReadonlyArray<FileChange>
  /** Folded Activity fold ids: section names + tree containers ("node:<id>"). */
  readonly stackCollapsed: ReadonlySet<string>
  /** Activity (stack) view cursor: index into its navigable rows. */
  readonly stackCursor: number
}

export const emptySidePane: SidePaneState = {
  tree: emptyTree,
  skillsLoaded: [],
  instructions: [],
  view: "stack",
  contextCursor: 0,
  contextCollapsed: new Set(),
  contextSelected: new Set(),
  contextHandoffSelected: new Set(),
  stats: emptyStats,
  filesChanged: [],
  stackCollapsed: new Set(["files", "skills", "instructions"]),
  stackCursor: 0,
}

// --- context-tree navigation (pure; the driver re-derives rows each call) ---

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(n, hi))

export const contextRows = (state: SidePaneState): ReadonlyArray<ContextRowData> =>
  buildContextRowsData(
    state.context ?? [],
    state.contextCollapsed,
    state.contextSelected,
    state.contextHandoffSelected,
  )

/** Window start that keeps the cursor visible (centred-ish), like followCursor. */
export const sideStart = (total: number, cursor: number, height: number): number =>
  total <= height ? 0 : clamp(cursor - Math.floor(height / 2), 0, total - height)

/** Window-relative row of the cursor for a pane `height`, or -1 if none. */
export const sideCursorRowAt = (state: SidePaneState, height: number): number => {
  const rows = contextRows(state)
  if (rows.length === 0 || height <= 0) return -1
  const cursor = clamp(state.contextCursor, 0, rows.length - 1)
  const start = sideStart(rows.length, cursor, height)
  const r = cursor - start
  return r >= 0 && r < height ? r : -1
}

export const sideCursorMove = (state: SidePaneState, delta: number): SidePaneState => {
  const n = contextRows(state).length
  if (n === 0) return state
  return { ...state, contextCursor: clamp(state.contextCursor + delta, 0, n - 1) }
}
export const sideCursorToTop = (state: SidePaneState): SidePaneState => ({
  ...state,
  contextCursor: 0,
})
export const sideCursorToEnd = (state: SidePaneState): SidePaneState => {
  const n = contextRows(state).length
  return { ...state, contextCursor: Math.max(0, n - 1) }
}
/** Fold/unfold the segment under the cursor (no-op on non-collapsible rows). */
export const sideToggleNode = (state: SidePaneState): SidePaneState => {
  const rows = contextRows(state)
  const row = rows[clamp(state.contextCursor, 0, Math.max(0, rows.length - 1))]
  if (row === undefined || !row.collapsible || row.groupId === undefined) return state
  const next = new Set(state.contextCollapsed)
  if (next.has(row.groupId)) next.delete(row.groupId)
  else next.add(row.groupId)
  return { ...state, contextCollapsed: next }
}
/** The row under the cursor (for the driver's Enter = jump-or-fold decision). */
export const sideCurrentRow = (state: SidePaneState): ContextRowData | undefined =>
  contextRows(state)[clamp(state.contextCursor, 0, Math.max(0, contextRows(state).length - 1))]

/**
 * Toggle selection of the unit under the cursor: a `turn` row (its messages) or
 * an archived `handoff` segment row (its summary). A handoff and its own inner
 * turns are mutually exclusive — selecting one clears the other for that handoff
 * (summary OR raw messages, never both). No-op on other rows.
 */
export const sideToggleSelect = (state: SidePaneState): SidePaneState => {
  const row = sideCurrentRow(state)
  const segments = state.context ?? []

  // Archived handoff: select its summary; drop its inner turns.
  if (row?.kind === "segment" && row.handoffIndex !== undefined) {
    const handoffs = new Set(state.contextHandoffSelected)
    const turns = new Set(state.contextSelected)
    if (handoffs.has(row.handoffIndex)) {
      handoffs.delete(row.handoffIndex)
    } else {
      handoffs.add(row.handoffIndex)
      const range = archivedTurnRanges(segments).get(row.handoffIndex)
      if (range !== undefined) {
        for (let i = range.start; i < range.start + range.count; i++) turns.delete(i)
      }
    }
    return { ...state, contextHandoffSelected: handoffs, contextSelected: turns }
  }

  // Turn: select its messages; if it belongs to a selected handoff, drop that handoff.
  if (row?.kind === "turn" && row.turnIndex !== undefined) {
    const turns = new Set(state.contextSelected)
    const handoffs = new Set(state.contextHandoffSelected)
    if (turns.has(row.turnIndex)) {
      turns.delete(row.turnIndex)
    } else {
      turns.add(row.turnIndex)
      const owner = handoffOwningTurn(segments, row.turnIndex)
      if (owner !== undefined) handoffs.delete(owner)
    }
    return { ...state, contextSelected: turns, contextHandoffSelected: handoffs }
  }

  return state
}

