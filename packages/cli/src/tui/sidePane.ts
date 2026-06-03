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
    `${ansi.dim} (${formatTokens(s.cacheReadTokens)} cached)${ansi.reset}`
  const win = s.contextWindow > 0 ? formatTokens(s.contextWindow) : "?"
  const gaugeLine = `${ansi.dim}ctx${ansi.reset} ${gauge(s.inputTokens, s.contextWindow, 8)} ${ansi.fgGray}${formatTokens(s.inputTokens)}/${win}${ansi.reset}${cached}`
  const elapsed = s.startedAt > 0 ? fmtDur(now - s.startedAt) : "0s"
  const meta = `${ansi.dim}${formatTokens(s.outputTokens)} tok out · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${elapsed}${ansi.reset}`
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

const containerGlyph = (node: TreeNode, collapsed: boolean): string => {
  const color =
    node.status === "running"
      ? ansi.fgYellow
      : node.status === "error"
        ? ansi.fgRed
        : ansi.fgGray
  return `${color}${collapsed ? "▸" : "▾"}${ansi.reset}`
}

/** One rendered Activity row; `foldId` marks a foldable row (section or tree node). */
interface StackRow {
  readonly line: string
  readonly foldId?: string
}

/**
 * Walk the execution tree into `StackRow`s. Container nodes (turn/subagent) are
 * foldable (`foldId = "node:<id>"`): a collapsed one shows `▸`, a trailing
 * `· N tools`, and hides its children. Leaf tool rows carry no `foldId`.
 */
const treeRows = (
  node: TreeNode,
  depth: number,
  collapsed: ReadonlySet<string>,
  spinnerFrame: number,
  now: number,
  width: number,
  out: StackRow[],
): void => {
  const indent = "  ".repeat(depth)
  const isContainer = node.kind === "turn" || node.kind === "subagent"
  const foldId = isContainer ? `node:${node.id}` : undefined
  const folded = foldId !== undefined && collapsed.has(foldId)
  const glyph = isContainer ? containerGlyph(node, folded) : statusGlyph(node, spinnerFrame)
  const count =
    folded && node.children.length > 0
      ? `${ansi.dim} · ${node.children.length} tool${node.children.length === 1 ? "" : "s"}${ansi.reset}`
      : ""
  const detail =
    node.detail !== undefined ? ` ${ansi.dim}${node.detail}${ansi.reset}` : ""
  let line = `${indent}${glyph} ${node.label}${count}${detail}`
  if (isContainer) {
    line += ` ${ansi.dim}${fmtDur((node.endedAt ?? now) - node.startedAt)}${ansi.reset}`
  }
  out.push({ line: truncate(line, width), ...(foldId !== undefined ? { foldId } : {}) })

  if (!folded) {
    for (const child of node.children) {
      treeRows(child, depth + 1, collapsed, spinnerFrame, now, width, out)
    }
  }
}

// --- Activity (stack) view: a navigable rows model ---

/**
 * The Activity view as a flat list of rows: a stats header, the live tree, then
 * the foldable files/skills/instructions sections. Single source of truth for
 * both rendering and navigation (row count + `foldId`s are width-independent).
 */
const stackModel = (
  state: SidePaneState,
  spinnerFrame: number,
  now: number,
  width: number,
): ReadonlyArray<StackRow> => {
  const rows: StackRow[] = []
  for (const line of renderStats(state.stats, width, now)) rows.push({ line })
  rows.push({ line: "" })
  if (state.tree.roots.length === 0) {
    rows.push({ line: `${ansi.dim}(idle)${ansi.reset}` })
  } else {
    for (const root of state.tree.roots) {
      treeRows(root, 0, state.stackCollapsed, spinnerFrame, now, width, rows)
    }
  }
  rows.push({ line: "" })
  const section = (id: string, lines: ReadonlyArray<string>): void => {
    lines.forEach((line, i) => rows.push(i === 0 ? { line, foldId: id } : { line }))
  }
  section("files", renderFilesSection(state.filesChanged, width, state.stackCollapsed.has("files")))
  section("skills", renderListSection("skills", state.skillsLoaded, width, state.stackCollapsed.has("skills")))
  section(
    "instructions",
    renderListSection(
      "instructions",
      state.instructions.map((i) => prettyPath(i.path)),
      width,
      state.stackCollapsed.has("instructions"),
    ),
  )
  return rows
}

/** Navigable rows (metadata stable regardless of width/now). */
export const stackRows = (state: SidePaneState): ReadonlyArray<StackRow> =>
  stackModel(state, 0, 0, 120)

export const stackCursorMove = (state: SidePaneState, delta: number): SidePaneState => {
  const n = stackRows(state).length
  if (n === 0) return state
  return { ...state, stackCursor: clamp(state.stackCursor + delta, 0, n - 1) }
}
export const stackCursorToTop = (state: SidePaneState): SidePaneState => ({
  ...state,
  stackCursor: 0,
})
export const stackCursorToEnd = (state: SidePaneState): SidePaneState => ({
  ...state,
  stackCursor: Math.max(0, stackRows(state).length - 1),
})

/**
 * Fold/unfold the row under the Activity cursor — a section header
 * (files/skills/instructions) or a tree container (turn/subagent). No-op off a
 * foldable row.
 */
export const stackToggle = (state: SidePaneState): SidePaneState => {
  const rows = stackRows(state)
  const row = rows[clamp(state.stackCursor, 0, Math.max(0, rows.length - 1))]
  if (row?.foldId === undefined) return state
  const next = new Set(state.stackCollapsed)
  if (next.has(row.foldId)) next.delete(row.foldId)
  else next.add(row.foldId)
  return { ...state, stackCollapsed: next }
}

/** Window-relative row of the Activity cursor for a pane `height`, or -1. */
export const stackCursorRowAt = (state: SidePaneState, height: number): number => {
  const n = stackRows(state).length
  if (n === 0 || height <= 0) return -1
  const cursor = clamp(state.stackCursor, 0, n - 1)
  const start = sideStart(n, cursor, height)
  const r = cursor - start
  return r >= 0 && r < height ? r : -1
}

/**
 * Render the side pane. Context view: the navigable message tree. Activity
 * view: a stats header, the live execution tree (tail-windowed), and the
 * foldable files/skills/instructions sections — navigable with its own cursor
 * when focused. Truncates per row at `cols`.
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

  // Activity view: a stats header, the live tree, and the foldable
  // files/skills/instructions sections — one navigable list. Windowed to follow
  // the cursor when focused, else bottom-anchored so the newest activity and the
  // section summaries stay visible. The focused row gets the cursor tint.
  const model = stackModel(state, spinnerFrame, now, cols)
  const total = model.length
  const cursor = clamp(state.stackCursor, 0, Math.max(0, total - 1))
  const start = focused ? sideStart(total, cursor, rows) : Math.max(0, total - rows)
  const visible = model.slice(start, start + rows)
  const out = visible.map((r, i) => {
    const line = padRight(truncate(r.line, cols), cols)
    if (focused && start + i === cursor) {
      return (
        ansi.bgCursorLine +
        line.split(ansi.reset).join(ansi.reset + ansi.bgCursorLine) +
        ansi.reset
      )
    }
    return line
  })
  while (out.length < rows) out.push("")
  return out.slice(0, rows).map((line) => padRight(line, cols))
}
