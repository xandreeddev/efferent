/**
 * Live model of what the agent is doing, built from the event stream:
 * turns → tool calls → (sub-agents → their turns/tools). Pure, immutable
 * reducers; the TUI renders this in the right pane.
 */

export type NodeStatus = "running" | "ok" | "error"
export type NodeKind = "turn" | "tool" | "subagent" | "skill"

export interface TreeNode {
  readonly id: number
  readonly kind: NodeKind
  readonly label: string
  readonly detail?: string
  readonly status: NodeStatus
  readonly startedAt: number
  readonly endedAt?: number
  readonly children: ReadonlyArray<TreeNode>
}

export interface ExecutionTree {
  readonly roots: ReadonlyArray<TreeNode>
  /** Node ids root→deepest open container (current turn / open sub-agent). */
  readonly openPath: ReadonlyArray<number>
  readonly nextId: number
}

export const emptyTree: ExecutionTree = {
  roots: [],
  openPath: [],
  nextId: 1,
}

// ---- tree-walking helpers (immutable) ----

const mapNode = (
  node: TreeNode,
  id: number,
  f: (n: TreeNode) => TreeNode,
): TreeNode => {
  if (node.id === id) return f(node)
  let changed = false
  const children = node.children.map((c) => {
    const next = mapNode(c, id, f)
    if (next !== c) changed = true
    return next
  })
  return changed ? { ...node, children } : node
}

const mapRoots = (
  roots: ReadonlyArray<TreeNode>,
  id: number,
  f: (n: TreeNode) => TreeNode,
): ReadonlyArray<TreeNode> => roots.map((r) => mapNode(r, id, f))

/** Append `child` under the node with `parentId`. */
const appendChild = (
  roots: ReadonlyArray<TreeNode>,
  parentId: number,
  child: TreeNode,
): ReadonlyArray<TreeNode> =>
  mapRoots(roots, parentId, (n) => ({
    ...n,
    children: [...n.children, child],
  }))

const findNode = (
  roots: ReadonlyArray<TreeNode>,
  id: number,
): TreeNode | undefined => {
  for (const r of roots) {
    if (r.id === id) return r
    const inner = findNode(r.children, id)
    if (inner !== undefined) return inner
  }
  return undefined
}

/** The id of the deepest currently-open container, or undefined for root. */
const openContainer = (tree: ExecutionTree): number | undefined =>
  tree.openPath.length > 0 ? tree.openPath[tree.openPath.length - 1] : undefined

const addNode = (
  tree: ExecutionTree,
  node: Omit<TreeNode, "id" | "children">,
): { tree: ExecutionTree; id: number } => {
  const id = tree.nextId
  const full: TreeNode = { ...node, id, children: [] }
  const parent = openContainer(tree)
  const roots =
    parent === undefined
      ? [...tree.roots, full]
      : appendChild(tree.roots, parent, full)
  return { tree: { ...tree, roots, nextId: id + 1 }, id }
}

const closeNode = (
  tree: ExecutionTree,
  id: number,
  status: NodeStatus,
  detail: string | undefined,
  now: number,
): ExecutionTree => ({
  ...tree,
  roots: mapRoots(tree.roots, id, (n) => ({
    ...n,
    status,
    endedAt: now,
    ...(detail !== undefined ? { detail } : {}),
  })),
})

// ---- reducers (one per event) ----

/** Start a turn under the deepest open sub-agent (or root). */
export const onTurnStart = (
  tree: ExecutionTree,
  turnIndex: number,
  now: number,
): ExecutionTree => {
  // Close a previous turn still open at the top of the path so turns are
  // siblings, not nested under each other.
  let base = tree
  const topId = base.openPath[base.openPath.length - 1]
  if (topId !== undefined && findNode(base.roots, topId)?.kind === "turn") {
    base = {
      ...closeNode(base, topId, "ok", undefined, now),
      openPath: base.openPath.slice(0, -1),
    }
  }
  const { tree: t, id } = addNode(base, {
    kind: "turn",
    label: `turn ${turnIndex + 1}`,
    status: "running",
    startedAt: now,
  })
  // The turn becomes the open container *within* its parent context.
  return { ...t, openPath: [...base.openPath, id] }
}

export const onToolStart = (
  tree: ExecutionTree,
  label: string,
  now: number,
): { tree: ExecutionTree; id: number } =>
  addNode(tree, { kind: "tool", label, status: "running", startedAt: now })

export const onToolEnd = (
  tree: ExecutionTree,
  id: number,
  ok: boolean,
  detail: string | undefined,
  now: number,
): ExecutionTree => closeNode(tree, id, ok ? "ok" : "error", detail, now)

export const onSubAgentStart = (
  tree: ExecutionTree,
  label: string,
  now: number,
): ExecutionTree => {
  const { tree: t, id } = addNode(tree, {
    kind: "subagent",
    label,
    status: "running",
    startedAt: now,
  })
  return { ...t, openPath: [...t.openPath, id] }
}

export const onSubAgentEnd = (
  tree: ExecutionTree,
  ok: boolean,
  detail: string | undefined,
  now: number,
): ExecutionTree => {
  // Find the deepest open subagent in openPath, close it, pop it (and
  // any turns opened inside it).
  for (let i = tree.openPath.length - 1; i >= 0; i--) {
    const id = tree.openPath[i]!
    const node = findNode(tree.roots, id)
    if (node?.kind === "subagent") {
      const closed = closeNode(tree, id, ok ? "ok" : "error", detail, now)
      return { ...closed, openPath: tree.openPath.slice(0, i) }
    }
  }
  return tree
}

export const onSkillLoad = (
  tree: ExecutionTree,
  name: string,
  now: number,
): ExecutionTree =>
  addNode(tree, {
    kind: "skill",
    label: `skill ${name}`,
    status: "ok",
    startedAt: now,
    endedAt: now,
  }).tree

/** Mark every still-running node ok and collapse the open path. */
export const onAgentEnd = (
  tree: ExecutionTree,
  now: number,
): ExecutionTree => {
  const closeRunning = (n: TreeNode): TreeNode => {
    const children = n.children.map(closeRunning)
    if (n.status === "running") {
      return { ...n, status: "ok", endedAt: now, children }
    }
    return { ...n, children }
  }
  return { ...tree, roots: tree.roots.map(closeRunning), openPath: [] }
}
