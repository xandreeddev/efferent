import { basename } from "node:path"
import type { AgentContextNode } from "@efferent/core"
import { glyph } from "./theme/index.js"
import { formatTokens } from "./statusBar.js"

/**
 * The **agent navigation pane** (the `:tree` view): every session in the
 * workspace — the *manual branches* (conversations, incl. `:build` forks) as
 * roots, each with its *agent branches* (the persistent sub-agent context
 * tree from `listTree`) nested beneath, reconstructed by `parentId`. Mirrors
 * `contextView`/`sidePane` exactly — a pure flattener → ordered
 * {@link TreeRowData}, the shared `paneNav` motions move a cursor over it, and
 * `ContextTree.tsx` renders each row's structured `display`. No Solid/OpenTUI.
 */

export interface TreeNodeDisplay {
  readonly kind: "node"
  /** Row label: the spawner-given title, else the scope dir basename. */
  readonly label: string
  /** Scope dir basename — shown dim after a title so the scope stays visible. */
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
  /** This node's session is open in the preview — the composer feeds IT. */
  readonly active: boolean
  readonly folded: boolean
  readonly hasChildren: boolean
  readonly nodeId: string
}

/** A conversation root in the navigator — Enter makes it the active session. */
export interface TreeConversationDisplay {
  readonly kind: "conversation"
  readonly label: string
  /** This is the live session the input feeds. */
  readonly active: boolean
  readonly conversationId: string
  /** How many agent-context nodes hang off it (all depths). */
  readonly nodeCount: number
  readonly folded: boolean
  readonly hasChildren: boolean
}

export type TreeRowDisplay = TreeNodeDisplay | TreeConversationDisplay

/** A workspace conversation as the navigator consumes it (label pre-formatted). */
export interface NavConversation {
  readonly id: string
  readonly label: string
  readonly active: boolean
  /** The session's display name alone (no date) — the header chrome reads it. */
  readonly title?: string
  /** Persisted message count — the sessions list shows it as `N msgs`. */
  readonly messageCount?: number
  /** Last-activity timestamp — the sessions list shows it as a relative time. */
  readonly updatedAt?: number
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

const rail = (
  depth: number,
  flags: ReadonlyArray<boolean>,
  isLast: boolean,
): TreeRail =>
  depth === 0
    ? { prefix: "", connector: "" }
    : {
        prefix: flags.map((f) => (f ? glyph.tree.vert : glyph.tree.skip)).join(""),
        connector: isLast ? glyph.tree.corner : glyph.tree.tee,
      }

/**
 * Flatten the navigator into ordered rows, honouring `collapsed` (a folded row
 * hides its descendants). With conversations, each is a depth-0 `head` whose
 * agent-context roots nest at depth 1; without (`conversations` empty — e.g. a
 * store hiccup), the agent nodes render as a plain forest, exactly the old
 * `:tree`. Fold ids: `tree:conv:<id>` for conversations, `tree:<id>` for nodes.
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
export const buildNavRows = (
  conversations: ReadonlyArray<NavConversation>,
  nodes: ReadonlyArray<AgentContextNode>,
  collapsed: ReadonlySet<string>,
  currentRef?: string,
  opts: {
    /** Nest EVERY parentless node under the (single) conversation row, ignoring
     *  `rootConversationId` — for a pre-scoped node list whose synthetic root
     *  may not know the real conversation id yet. */
    readonly adoptAll?: boolean
    /** The agent node whose session the composer currently feeds (an open
     *  preview): IT carries the `active` tag, and conversation rows lose
     *  theirs — "active" means "where a typed message goes", and only one
     *  row can claim that. */
    readonly activeNodeId?: string
  } = {},
): ReadonlyArray<TreeRowData> => {
  const byParent = childrenByParent(nodes)
  const rows: TreeRowData[] = []

  const walkNode = (
    node: AgentContextNode,
    depth: number,
    flags: ReadonlyArray<boolean>,
    isLast: boolean,
  ): void => {
    const children = byParent.get(node.id) ?? []
    const hasChildren = children.length > 0
    const foldId = hasChildren ? `tree:${node.id}` : undefined
    const folded = foldId !== undefined && collapsed.has(foldId)
    rows.push({
      key: `tree-row:${node.id}`,
      depth,
      rail: rail(depth, flags, isLast),
      ...(foldId !== undefined ? { foldId } : {}),
      head: depth === 0,
      display: {
        kind: "node",
        label: node.title ?? (basename(node.folder) || node.folder),
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
        active: node.id === opts.activeNodeId,
        folded,
        hasChildren,
        nodeId: node.id,
      },
    })
    if (!folded) {
      // A depth-0 root's children start a fresh rail (separate trees); deeper
      // children inherit this node's continuation column.
      const childFlags = depth === 0 ? [] : [...flags, !isLast]
      children.forEach((c, i) => walkNode(c, depth + 1, childFlags, i === children.length - 1))
    }
  }

  if (conversations.length === 0) {
    const roots = byParent.get(null) ?? []
    roots.forEach((r, i) => walkNode(r, 0, [], i === roots.length - 1))
    return rows
  }

  const countSubtree = (roots: ReadonlyArray<AgentContextNode>): number => {
    let n = 0
    const stack = [...roots]
    for (let cur = stack.pop(); cur !== undefined; cur = stack.pop()) {
      n++
      stack.push(...(byParent.get(cur.id) ?? []))
    }
    return n
  }

  for (const conv of conversations) {
    const agentRoots =
      opts.adoptAll === true
        ? (byParent.get(null) ?? [])
        : (byParent.get(null) ?? []).filter((r) => r.rootConversationId === conv.id)
    const hasChildren = agentRoots.length > 0
    const foldId = hasChildren ? `tree:conv:${conv.id}` : undefined
    const folded = foldId !== undefined && collapsed.has(foldId)
    rows.push({
      key: `tree-row:conv:${conv.id}`,
      depth: 0,
      rail: { prefix: "", connector: "" },
      ...(foldId !== undefined ? { foldId } : {}),
      head: true,
      display: {
        kind: "conversation",
        label: conv.label,
        // An open node preview steals the tag — the composer feeds that node.
        active: conv.active && opts.activeNodeId === undefined,
        conversationId: conv.id,
        nodeCount: countSubtree(agentRoots),
        folded,
        hasChildren,
      },
    })
    if (!folded) {
      agentRoots.forEach((r, i) => walkNode(r, 1, [], i === agentRoots.length - 1))
    }
  }
  return rows
}

/** The old node-only `:tree` flatten — `buildNavRows` with no conversations. */
export const buildTreeRowsData = (
  nodes: ReadonlyArray<AgentContextNode>,
  collapsed: ReadonlySet<string>,
  currentRef?: string,
): ReadonlyArray<TreeRowData> => buildNavRows([], nodes, collapsed, currentRef)

/** The searchable text of one tree row (for `/` search over the side pane). */
export const treeRowText = (row: TreeRowData): string =>
  row.display.kind === "conversation"
    ? row.display.label
    : `${row.display.label} ${row.display.folder} ${row.display.summary ?? ""}`.trim()
