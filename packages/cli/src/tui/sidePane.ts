import { ansi, padRight, truncate, SPINNER_FRAMES } from "./terminal.js"
import { emptyTree, type ExecutionTree, type TreeNode } from "./executionTree.js"
import { formatTokens, gauge } from "./statusBar.js"
import {
  archivedTurnRanges,
  buildContextRows,
  type ContextRow,
  type ContextSegment,
  handoffOwningTurn,
  renderContextView,
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
  /** Folded Activity section ids ("files" / "skills" / "instructions"). */
  readonly sectionsCollapsed: ReadonlySet<string>
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
  sectionsCollapsed: new Set(["files", "skills", "instructions"]),
}

// --- context-tree navigation (pure; the driver re-derives rows each call) ---

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(n, hi))

export const contextRows = (state: SidePaneState): ReadonlyArray<ContextRow> =>
  buildContextRows(
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
export const sideCurrentRow = (state: SidePaneState): ContextRow | undefined =>
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

const homeDir = (() => {
  try {
    return process.env["HOME"] ?? ""
  } catch {
    return ""
  }
})()

const prettyPath = (p: string): string =>
  homeDir !== "" && p.startsWith(homeDir) ? `~${p.slice(homeDir.length)}` : p

const fmtDur = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m${Math.round(s - m * 60)}s`
}

const foldGlyph = (collapsed: boolean): string =>
  `${ansi.fgGray}${collapsed ? "▸" : "▾"}${ansi.reset}`

/** A foldable Activity section header: `▸ label (N)` + an optional summary. */
const sectionHead = (
  label: string,
  count: number,
  collapsed: boolean,
  summary = "",
): string =>
  `${foldGlyph(collapsed)} ${ansi.bold}${ansi.fgGray}${label}${ansi.reset} ${ansi.dim}(${count})${ansi.reset}${summary}`

/** The Activity stats header: a context gauge + a cumulative one-liner. */
const renderStats = (s: SessionStats, width: number, now: number): string[] => {
  const cached =
    s.cacheReadTokens > 0
      ? `${ansi.dim} (${formatTokens(s.cacheReadTokens)} cached)${ansi.reset}`
      : ""
  const win = s.contextWindow > 0 ? formatTokens(s.contextWindow) : "?"
  const gaugeLine = `${gauge(s.inputTokens, s.contextWindow, 10)} ${ansi.fgGray}${formatTokens(s.inputTokens)}/${win}${ansi.reset}${cached}`
  const elapsed = s.startedAt > 0 ? fmtDur(now - s.startedAt) : "0s"
  const meta = `${ansi.dim}↓${formatTokens(s.outputTokens)} out · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${elapsed}${ansi.reset}`
  return [truncate(gaugeLine, width), truncate(meta, width)]
}

/** The foldable `files` section: header carries a `+A/-D` diffstat summary. */
const renderFilesSection = (
  files: ReadonlyArray<FileChange>,
  width: number,
  collapsed: boolean,
): string[] => {
  const tot = files.reduce(
    (a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }),
    { added: 0, removed: 0 },
  )
  const summary =
    files.length > 0
      ? ` ${ansi.fgGreen}+${tot.added}${ansi.reset}${ansi.dim}/${ansi.reset}${ansi.fgRed}-${tot.removed}${ansi.reset}`
      : ""
  const head = sectionHead("files", files.length, collapsed, summary)
  if (collapsed || files.length === 0) return [head]
  const rows = files.map((f) =>
    truncate(
      `   ${ansi.fgGray}${f.path}${ansi.reset} ${ansi.fgGreen}+${f.added}${ansi.reset}${ansi.dim}/${ansi.reset}${ansi.fgRed}-${f.removed}${ansi.reset}`,
      width,
    ),
  )
  return [head, ...rows]
}

/** A foldable list section (skills / instructions): one line when collapsed. */
const renderListSection = (
  label: string,
  items: ReadonlyArray<string>,
  width: number,
  collapsed: boolean,
): string[] => {
  const head = sectionHead(label, items.length, collapsed)
  if (collapsed || items.length === 0) return [head]
  return [
    head,
    ...items.map((i) => truncate(`   ${ansi.fgGray}·${ansi.reset} ${i}`, width)),
  ]
}

const statusGlyph = (node: TreeNode, spinnerFrame: number): string => {
  if (node.status === "running") {
    return `${ansi.fgYellow}${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}${ansi.reset}`
  }
  if (node.status === "error") return `${ansi.fgRed}✗${ansi.reset}`
  return `${ansi.fgGreen}✓${ansi.reset}`
}

const containerGlyph = (node: TreeNode): string => {
  const color =
    node.status === "running"
      ? ansi.fgYellow
      : node.status === "error"
        ? ansi.fgRed
        : ansi.fgGray
  return `${color}▾${ansi.reset}`
}

const renderNode = (
  node: TreeNode,
  depth: number,
  spinnerFrame: number,
  now: number,
  width: number,
  out: string[],
): void => {
  const indent = "  ".repeat(depth)
  const isContainer = node.kind === "turn" || node.kind === "subagent"
  const glyph = isContainer ? containerGlyph(node) : statusGlyph(node, spinnerFrame)
  const detail =
    node.detail !== undefined ? ` ${ansi.dim}${node.detail}${ansi.reset}` : ""
  let line = `${indent}${glyph} ${node.label}${detail}`

  if (isContainer) {
    const dur = fmtDur((node.endedAt ?? now) - node.startedAt)
    line += ` ${ansi.dim}${dur}${ansi.reset}`
  }
  out.push(truncate(line, width))

  for (const child of node.children) {
    renderNode(child, depth + 1, spinnerFrame, now, width, out)
  }
}

const renderTreeLines = (
  tree: ExecutionTree,
  spinnerFrame: number,
  now: number,
  width: number,
): string[] => {
  if (tree.roots.length === 0) {
    return [`${ansi.dim}(idle)${ansi.reset}`]
  }
  const out: string[] = []
  for (const root of tree.roots) {
    renderNode(root, 0, spinnerFrame, now, width, out)
  }
  return out
}

/**
 * Render the side pane: the live execution tree on top (tail-windowed so
 * the newest activity stays visible), with skills + instructions sections
 * pinned below. Truncates per row at `cols`.
 */
export const renderSidePane = (
  state: SidePaneState,
  rows: number,
  cols: number,
  spinnerFrame = 0,
  focused = false,
  now: number = Date.now(),
): string[] => {
  if (rows <= 0 || cols <= 0) return []

  // Context view: the navigable message tree. Windowed to follow the cursor;
  // the focused row gets the cursor tint (the hardware block cursor sits there).
  if (state.view === "context") {
    const rowsList = contextRows(state)
    if (rowsList.length === 0) {
      const out = [`${ansi.dim}(no conversation yet)${ansi.reset}`]
      while (out.length < rows) out.push("")
      return out.slice(0, rows).map((line) => padRight(line, cols))
    }
    const cursor = clamp(state.contextCursor, 0, rowsList.length - 1)
    const start = sideStart(rowsList.length, cursor, rows)
    const visible = rowsList.slice(start, start + rows)
    const lines = renderContextView(visible, cols, focused ? cursor - start : -1, focused)
    const out = [...lines]
    while (out.length < rows) out.push("")
    return out.slice(0, rows).map((line) => padRight(line, cols))
  }

  // Activity view: a stats header on top, the live tree filling the middle
  // (tail-windowed), and the foldable files/skills/instructions sections pinned
  // to the floor (collapsed by default — each still shows its key-info summary).
  const header = [...renderStats(state.stats, cols, now), ""]
  const bottom = [
    ...renderFilesSection(state.filesChanged, cols, state.sectionsCollapsed.has("files")),
    ...renderListSection("skills", state.skillsLoaded, cols, state.sectionsCollapsed.has("skills")),
    ...renderListSection(
      "instructions",
      state.instructions.map((i) => prettyPath(i.path)),
      cols,
      state.sectionsCollapsed.has("instructions"),
    ),
  ]

  const treeRows = Math.max(0, rows - header.length - bottom.length - 1)
  const treeLines = renderTreeLines(state.tree, spinnerFrame, now, cols)
  const treeWindow =
    treeLines.length > treeRows
      ? treeLines.slice(treeLines.length - treeRows)
      : treeLines

  const out: string[] = [...header, ...treeWindow]
  while (out.length < rows - bottom.length) out.push("")
  out.push(...bottom)
  return out.slice(0, rows).map((line) => padRight(line, cols))
}
