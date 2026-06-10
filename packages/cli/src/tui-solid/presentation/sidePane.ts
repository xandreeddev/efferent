import { emptyTree, type ExecutionTree, type TreeNode } from "./executionTree.js"
import {
  archivedTurnRanges,
  buildContextRowsData,
  type ContextRowData,
  type ContextSegment,
  handoffOwningTurn,
} from "./contextView.js"
import { clampCursor, foldAt, rowToEnd, rowToTop, stepHead, stepRow } from "./paneNav.js"
import { buildNavRows, type NavConversation, type TreeRowData } from "./contextTreeView.js"
import type { AgentContextNode } from "@efferent/core"

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
  /** `inputTokens` is a chars/4 resume estimate (no persisted usage) — shown `~`. */
  readonly estimated?: boolean
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
  // A real provider count replaces any resume estimate.
  estimated: false,
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
  /** Persisted agent-context-tree nodes (from `listTree`); shown when view==="tree". */
  readonly treeNodes?: ReadonlyArray<AgentContextNode>
  /** Workspace conversations — the navigator's roots (active one marked). */
  readonly treeConversations?: ReadonlyArray<NavConversation>
  /** Workspace git HEAD at tree-load time — nodes stamped with another ref are stale. */
  readonly treeWorkspaceRef?: string
}

/**
 * **Nav** — *where the cursor is / what's folded or selected*. Written only by
 * keystrokes (the `keys/` dispatch). Carries no tree/stats/files, so a nav write
 * can't clobber the live projection. The reducers below take `(nav, projection)`
 * and return a new `nav`: they *read* the projection (the context segments) to
 * compute rows, but only ever *write* nav.
 */
export interface SidePaneNav {
  /** Which view the side pane shows: the live agent stack, the context viewer, or the context tree. */
  readonly view: "stack" | "context" | "tree"
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
  /** Context-tree (`:tree`) cursor: index into its navigable rows. */
  readonly treeCursor: number
  /** Folded context-tree node ids ("tree:<id>"). */
  readonly treeCollapsed: ReadonlySet<string>
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
  treeCursor: 0,
  treeCollapsed: new Set(),
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
    ...(s.treeNodes !== undefined ? { treeNodes: s.treeNodes } : {}),
    ...(s.treeConversations !== undefined ? { treeConversations: s.treeConversations } : {}),
    ...(s.treeWorkspaceRef !== undefined ? { treeWorkspaceRef: s.treeWorkspaceRef } : {}),
  },
  nav: {
    view: s.view,
    contextCursor: s.contextCursor,
    contextCollapsed: s.contextCollapsed,
    contextSelected: s.contextSelected,
    contextHandoffSelected: s.contextHandoffSelected,
    stackCollapsed: s.stackCollapsed,
    stackCursor: s.stackCursor,
    treeCursor: s.treeCursor,
    treeCollapsed: s.treeCollapsed,
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
/** `[`/`]` — jump the context cursor to the prev/next head (a segment or turn row). */
export const sideCursorToHead = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
  dir: 1 | -1,
): SidePaneNav => {
  const heads = contextRows(nav, projection).map((r) => ({
    head: r.kind === "segment" || r.kind === "turn",
  }))
  return { ...nav, contextCursor: stepHead(heads, nav.contextCursor, dir) }
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

// --- Activity (stack) view navigation (pure; rows re-derived each call) ---

/**
 * The display payload for one Activity row, discriminated by kind. Structured
 * (not pre-styled) so the view computes the live bits itself — the running-node
 * spinner frame and the elapsed duration must update per frame, so they can't be
 * baked into a pure row. `node` rows carry the whole {@link TreeNode}; the view
 * renders just that node's own line (children are their own flattened rows).
 */
export type StackRowDisplay =
  | { readonly kind: "node"; readonly node: TreeNode; readonly folded: boolean }
  | {
      readonly kind: "section"
      readonly label: string
      readonly count: number
      readonly folded: boolean
      readonly summary?: string
    }
  | { readonly kind: "file"; readonly file: FileChange }
  | { readonly kind: "skill"; readonly name: string }
  | { readonly kind: "instruction"; readonly path: string }

/** One navigable Activity row: a {@link NavRow} (key/foldId/head) + indent depth
 *  + its structured display. Foldable rows carry `foldId` (`node:<id>` or the
 *  section name); top-level rows (tree roots + section headers) are `head`s. */
export interface StackRowData {
  readonly key: string
  readonly depth: number
  readonly foldId?: string
  readonly head?: boolean
  readonly display: StackRowDisplay
}

/**
 * Flatten the Activity dashboard into ordered navigable rows, honouring
 * `stackCollapsed` (folded tree containers + section headers). Mirrors
 * `Activity.tsx`'s render order exactly so the cursor index ↔ rendered row line
 * up: the execution tree (depth-first; `turn`/`subagent` are foldable
 * containers, `tool`/`skill` are leaves), then the `files`/`skills`/
 * `instructions` section headers with their child rows when expanded.
 */
export const buildStackRowsData = (
  projection: SidePaneProjection,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<StackRowData> => {
  const rows: StackRowData[] = []

  const walk = (node: TreeNode, depth: number): void => {
    const container = node.kind === "turn" || node.kind === "subagent"
    const foldId = container ? `node:${node.id}` : undefined
    const folded = foldId !== undefined && collapsed.has(foldId)
    rows.push({
      key: `stack:node:${node.id}`,
      depth,
      ...(foldId !== undefined ? { foldId } : {}),
      head: depth === 0,
      display: { kind: "node", node, folded },
    })
    if (!folded) for (const child of node.children) walk(child, depth + 1)
  }
  for (const root of projection.tree.roots) walk(root, 0)

  const section = (
    id: "files" | "skills" | "instructions",
    count: number,
    summary: string | undefined,
    children: () => void,
  ): void => {
    const folded = collapsed.has(id)
    rows.push({
      key: `stack:section:${id}`,
      depth: 0,
      foldId: id,
      head: true,
      display: { kind: "section", label: id, count, folded, ...(summary ? { summary } : {}) },
    })
    if (!folded) children()
  }

  const files = projection.filesChanged
  const totals = files.reduce(
    (a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }),
    { added: 0, removed: 0 },
  )
  section(
    "files",
    files.length,
    files.length > 0 ? ` +${totals.added}/-${totals.removed}` : undefined,
    () =>
      files.forEach((file, i) =>
        rows.push({ key: `stack:file:${i}`, depth: 1, display: { kind: "file", file } }),
      ),
  )
  section("skills", projection.skillsLoaded.length, undefined, () =>
    projection.skillsLoaded.forEach((name, i) =>
      rows.push({ key: `stack:skill:${i}`, depth: 1, display: { kind: "skill", name } }),
    ),
  )
  section("instructions", projection.instructions.length, undefined, () =>
    projection.instructions.forEach((ins, i) =>
      rows.push({
        key: `stack:instr:${i}`,
        depth: 1,
        display: { kind: "instruction", path: ins.path },
      }),
    ),
  )
  return rows
}

export const stackRows = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
): ReadonlyArray<StackRowData> => buildStackRowsData(projection, nav.stackCollapsed)

/** The searchable text of one Activity row (for `/` search over the side pane). */
export const stackRowText = (row: StackRowData): string => {
  const d = row.display
  switch (d.kind) {
    case "node":
      return `${d.node.label} ${d.node.detail ?? ""}`
    case "section":
      return d.label
    case "file":
      return d.file.path
    case "skill":
      return d.name
    case "instruction":
      return d.path
  }
}

/** `{`/`}` (and plain `j`/`k`, one line == one row here) — paragraph step. */
export const stackParagraph = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
  delta: number,
): SidePaneNav => ({ ...nav, stackCursor: stepRow(stackRows(nav, projection), nav.stackCursor, delta) })
/** `[`/`]` — jump to the prev/next head (tree root or section header). */
export const stackMessage = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
  dir: 1 | -1,
): SidePaneNav => ({ ...nav, stackCursor: stepHead(stackRows(nav, projection), nav.stackCursor, dir) })
export const stackToTop = (nav: SidePaneNav): SidePaneNav => ({ ...nav, stackCursor: rowToTop() })
export const stackToEnd = (nav: SidePaneNav, projection: SidePaneProjection): SidePaneNav => ({
  ...nav,
  stackCursor: rowToEnd(stackRows(nav, projection)),
})
/** `⇥`/`↵` — fold the tree container / section under the cursor (no-op on leaves). */
export const stackFold = (nav: SidePaneNav, projection: SidePaneProjection): SidePaneNav => ({
  ...nav,
  stackCollapsed: foldAt(stackRows(nav, projection), nav.stackCursor, nav.stackCollapsed),
})
/** The row under the cursor (for the driver's `↵` fold-or-noop decision). */
export const stackCurrentRow = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
): StackRowData | undefined => {
  const rows = stackRows(nav, projection)
  return rows[clampCursor(rows.length, nav.stackCursor)]
}

// --- context-tree (`:tree`) view navigation (pure; rows re-derived each call) ---

export const treeRows = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
): ReadonlyArray<TreeRowData> =>
  buildNavRows(
    projection.treeConversations ?? [],
    projection.treeNodes ?? [],
    nav.treeCollapsed,
    projection.treeWorkspaceRef,
  )

/** `{`/`}` (and plain `j`/`k`, one row per node) — paragraph step. */
export const treeParagraph = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
  delta: number,
): SidePaneNav => ({ ...nav, treeCursor: stepRow(treeRows(nav, projection), nav.treeCursor, delta) })
/** `[`/`]` — jump to the prev/next forest root (a `head` row). */
export const treeMessage = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
  dir: 1 | -1,
): SidePaneNav => ({ ...nav, treeCursor: stepHead(treeRows(nav, projection), nav.treeCursor, dir) })
export const treeToTop = (nav: SidePaneNav): SidePaneNav => ({ ...nav, treeCursor: rowToTop() })
export const treeToEnd = (nav: SidePaneNav, projection: SidePaneProjection): SidePaneNav => ({
  ...nav,
  treeCursor: rowToEnd(treeRows(nav, projection)),
})
/** `⇥`/`↵` — fold the node under the cursor (no-op on leaf nodes). */
export const treeFold = (nav: SidePaneNav, projection: SidePaneProjection): SidePaneNav => ({
  ...nav,
  treeCollapsed: foldAt(treeRows(nav, projection), nav.treeCursor, nav.treeCollapsed),
})
/** The row under the cursor (for resume/branch/drop + fold decisions). */
export const treeCurrentRow = (
  nav: SidePaneNav,
  projection: SidePaneProjection,
): TreeRowData | undefined => {
  const rows = treeRows(nav, projection)
  return rows[clampCursor(rows.length, nav.treeCursor)]
}

