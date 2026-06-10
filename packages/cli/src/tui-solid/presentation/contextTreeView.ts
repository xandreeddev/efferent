import { basename } from "node:path"
import type { AgentContextNode } from "@efferent/core"
import { glyph } from "./theme/index.js"
import { formatTokens } from "./statusBar.js"

/**
 * The browseable, branching **agent-context tree** (the `:tree` view): the
 * persistent record of every sub-agent spawned/resumed/branched in a
 * conversation, reconstructed from the flat `listTree` result by `parentId`.
 * Mirrors `contextView`/`sidePane` exactly — a pure flattener → ordered
 * {@link TreeRowData}, the shared `paneNav` motions move a cursor over it, and
 * `ContextTree.tsx` renders each row's structured `display`. No Solid/OpenTUI.
 */

export type TreeRowDisplay = {
  readonly kind: "node"
  /** Scope dir basename, for a compact label. */
  readonly folder: string
  readonly status: "running" | "ok" | "error"
  readonly edgeKind: "spawned" | "branched" | "resumed"
  readonly seedKind: "task" | "selection" | "handoff"
  readonly summary?: string
  readonly filesCount: number
  /** Billed tokens (input+output) this node consumed, formatted (`"38k tok"`). */
  readonly tokens?: string
  /** The workspace moved since this node ran — its context describes an older world. */
  readonly stale: boolean
  readonly folded: boolean
  readonly hasChildren: boolean
  readonly nodeId: string
}

/**
 * The row's git-graph rail, split so the view can colour the connector by
 * edge kind while the ancestor continuation columns stay dim. Both built from
 * fixed 2-char glyph cells, so total rail width = depth × 2.
 */
export interface TreeRail {
  /** Ancestor columns: `│ ` where that ancestor has more siblings below, else `  `. */
  readonly prefix: string
  /** This row's connector: `├─` mid-child, `└─` last child, empty for roots. */
  readonly connector: string
}

/** One navigable tree row: a `NavRow` (key/foldId/head) + rail/depth + display. */
export interface TreeRowData {
  readonly key: string
  readonly depth: number
  readonly rail: TreeRail
  readonly foldId?: string
  readonly head?: boolean
  readonly display: TreeRowDisplay
}

/** First line of a (possibly multi-line) summary, clipped for a one-line row. */
const firstLine = (s: string): string => {
  const line = s.split("\n", 1)[0] ?? ""
  return line.length <= 120 ? line : `${line.slice(0, 120)}…`
}

/** Group nodes by `parentId` (null = a forest root), each group oldest-first. */
const childrenByParent = (
  nodes: ReadonlyArray<AgentContextNode>,
): Map<string | null, AgentContextNode[]> => {
  const byParent = new Map<string | null, AgentContextNode[]>()
  for (const n of nodes) {
    const arr = byParent.get(n.parentId)
    if (arr !== undefined) arr.push(n)
    else byParent.set(n.parentId, [n])
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.createdAt - b.createdAt)
  return byParent
}

/**
 * Flatten the tree into ordered navigable rows, honouring `collapsed` (folded
 * nodes hide their descendants). Forest roots (`parentId === null`) are `head`s;
 * a node with children is foldable (`foldId = "tree:<id>"`).
 *
 * Each row carries a git-log-`--graph`-style rail built by the classic
 * ancestor-flags walk: `flags[i]` says whether the ancestor at depth `i+1` has
 * further siblings below (draw `│ ` in that column, else blank), and the row's
 * own connector is `├─` / `└─` by last-child-ness. Folding stays rail-correct
 * for free — it hides descendants, never siblings, so the visible rows'
 * continuation columns are unaffected.
 *
 * `currentRef` is the workspace's git HEAD at load time: a finished node
 * stamped with a *different* ref is marked `stale` — resuming it hands the
 * model in-context file reads from an older world.
 */
export const buildTreeRowsData = (
  nodes: ReadonlyArray<AgentContextNode>,
  collapsed: ReadonlySet<string>,
  currentRef?: string,
): ReadonlyArray<TreeRowData> => {
  const byParent = childrenByParent(nodes)
  const rows: TreeRowData[] = []

  const walk = (
    node: AgentContextNode,
    depth: number,
    flags: ReadonlyArray<boolean>,
    isLast: boolean,
  ): void => {
    const children = byParent.get(node.id) ?? []
    const hasChildren = children.length > 0
    const foldId = hasChildren ? `tree:${node.id}` : undefined
    const folded = foldId !== undefined && collapsed.has(foldId)
    const rail: TreeRail =
      depth === 0
        ? { prefix: "", connector: "" }
        : {
            prefix: flags.map((f) => (f ? glyph.tree.vert : glyph.tree.skip)).join(""),
            connector: isLast ? glyph.tree.corner : glyph.tree.tee,
          }
    rows.push({
      key: `tree-row:${node.id}`,
      depth,
      rail,
      ...(foldId !== undefined ? { foldId } : {}),
      head: depth === 0,
      display: {
        kind: "node",
        folder: basename(node.folder) || node.folder,
        status: node.status,
        edgeKind: node.edgeKind,
        seedKind: node.seed.kind,
        ...(node.returnSummary !== undefined ? { summary: firstLine(node.returnSummary) } : {}),
        filesCount: node.filesChanged.length,
        ...(node.usage !== undefined
          ? { tokens: `${formatTokens(node.usage.inputTokens + node.usage.outputTokens)} tok` }
          : {}),
        stale:
          node.status !== "running" &&
          node.workspaceRef !== undefined &&
          currentRef !== undefined &&
          node.workspaceRef !== currentRef,
        folded,
        hasChildren,
        nodeId: node.id,
      },
    })
    if (!folded) {
      // A root's children start a fresh rail (roots are visually separate
      // trees); deeper children inherit this node's continuation column.
      const childFlags = depth === 0 ? [] : [...flags, !isLast]
      children.forEach((c, i) => walk(c, depth + 1, childFlags, i === children.length - 1))
    }
  }

  const roots = byParent.get(null) ?? []
  roots.forEach((r, i) => walk(r, 0, [], i === roots.length - 1))
  return rows
}

/** The searchable text of one tree row (for `/` search over the side pane). */
export const treeRowText = (row: TreeRowData): string =>
  `${row.display.folder} ${row.display.summary ?? ""}`.trim()
