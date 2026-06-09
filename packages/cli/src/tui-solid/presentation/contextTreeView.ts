import { basename } from "node:path"
import type { AgentContextNode } from "@efferent/core"

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
  readonly folded: boolean
  readonly hasChildren: boolean
  readonly nodeId: string
}

/** One navigable tree row: a `NavRow` (key/foldId/head) + indent depth + display. */
export interface TreeRowData {
  readonly key: string
  readonly depth: number
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
 */
export const buildTreeRowsData = (
  nodes: ReadonlyArray<AgentContextNode>,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<TreeRowData> => {
  const byParent = childrenByParent(nodes)
  const rows: TreeRowData[] = []

  const walk = (node: AgentContextNode, depth: number): void => {
    const children = byParent.get(node.id) ?? []
    const hasChildren = children.length > 0
    const foldId = hasChildren ? `tree:${node.id}` : undefined
    const folded = foldId !== undefined && collapsed.has(foldId)
    rows.push({
      key: `tree-row:${node.id}`,
      depth,
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
        folded,
        hasChildren,
        nodeId: node.id,
      },
    })
    if (!folded) for (const c of children) walk(c, depth + 1)
  }

  for (const root of byParent.get(null) ?? []) walk(root, 0)
  return rows
}

/** The searchable text of one tree row (for `/` search over the side pane). */
export const treeRowText = (row: TreeRowData): string =>
  `${row.display.folder} ${row.display.summary ?? ""}`.trim()
