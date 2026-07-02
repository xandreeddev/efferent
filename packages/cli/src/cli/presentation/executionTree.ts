/**
 * Live model of what the agent is doing, built from the event stream:
 * turns → tool calls → (sub-agents → their turns/tools). Pure, immutable
 * reducers; the TUI renders this in the right pane.
 */

export type NodeStatus = "running" | "ok" | "error"
export type NodeKind = "run" | "turn" | "tool" | "subagent" | "skill"

export interface TreeNode {
  readonly id: number
  readonly kind: NodeKind
  readonly label: string
  readonly detail?: string
  readonly status: NodeStatus
  readonly startedAt: number
  readonly endedAt?: number
  /** For `subagent` containers: the persistent context-tree node id — lets the
   *  navigator's detail panel find a selected node's LIVE activity. */
  readonly nodeId?: string
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

/**
 * Start a RUN — the per-user-message root container the turns group under
 * (labelled with the prompt). Anything still open from the previous run is
 * closed first (`openPath` reset), so a run is always a depth-0 root and the
 * Activity pane reads `❯ prompt → its turns → their tools` instead of a flat
 * wall of `turn N` lines.
 */
export const onRunStart = (
  tree: ExecutionTree,
  subject: string,
  now: number,
): { tree: ExecutionTree; id: number } => {
  // Close whatever the previous run left open (its run node + any open turn).
  let base = tree
  for (let i = base.openPath.length - 1; i >= 0; i--) {
    const id = base.openPath[i]!
    const node = findNode(base.roots, id)
    if (node !== undefined && node.status === "running") {
      base = closeNode(base, id, "ok", undefined, now)
    }
  }
  base = { ...base, openPath: [] }
  const { tree: t, id } = addNode(base, {
    kind: "run",
    label: subject,
    status: "running",
    startedAt: now,
  })
  return { tree: { ...t, openPath: [id] }, id }
}

/** Close the run root (the turn inside was already closed by the loop's end). */
export const onRunEnd = (tree: ExecutionTree, ok: boolean, now: number): ExecutionTree => {
  const runId = tree.openPath[0]
  if (runId === undefined || findNode(tree.roots, runId)?.kind !== "run") return tree
  // Close any still-open descendants too (an interrupt skips their end events).
  let base = tree
  for (let i = base.openPath.length - 1; i >= 0; i--) {
    const id = base.openPath[i]!
    if (findNode(base.roots, id)?.status === "running") {
      base = closeNode(base, id, ok ? "ok" : "error", undefined, now)
    }
  }
  return { ...base, openPath: [] }
}

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

/** The deepest currently-open `turn` node's id (the running step), or undefined. */
export const openTurnId = (tree: ExecutionTree): number | undefined => {
  for (let i = tree.openPath.length - 1; i >= 0; i--) {
    const id = tree.openPath[i]!
    if (findNode(tree.roots, id)?.kind === "turn") return id
  }
  return undefined
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

/**
 * Attach a detail (e.g. per-LLM-call token usage `↑12k ↓340`) to the deepest
 * open turn node — set when the turn's `assistant_message` (with usage) lands.
 */
export const onTurnDetail = (
  tree: ExecutionTree,
  detail: string,
): ExecutionTree => {
  for (let i = tree.openPath.length - 1; i >= 0; i--) {
    const id = tree.openPath[i]!
    if (findNode(tree.roots, id)?.kind === "turn") {
      return { ...tree, roots: mapRoots(tree.roots, id, (n) => ({ ...n, detail })) }
    }
  }
  return tree
}

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

/**
 * **Keyed** sub-agent container: appended under `parentId` (its enclosing
 * sub-agent's tree node) when given, else under the deepest open turn, else at
 * root — and NEVER pushed onto `openPath`. The stack model breaks under
 * parallel fan-out (a second start nests inside the first; an end closes
 * whichever is deepest); keyed containers + {@link onToolStartUnder} attribute
 * interleaved events to the right run by id.
 */
export const onSubAgentStartKeyed = (
  tree: ExecutionTree,
  label: string,
  parentId: number | undefined,
  now: number,
  nodeId?: string,
): { tree: ExecutionTree; id: number } => {
  const id = tree.nextId
  const full: TreeNode = {
    id,
    kind: "subagent",
    label,
    status: "running",
    startedAt: now,
    ...(nodeId !== undefined ? { nodeId } : {}),
    children: [],
  }
  const anchor = parentId ?? openTurnId(tree)
  const roots =
    anchor === undefined ? [...tree.roots, full] : appendChild(tree.roots, anchor, full)
  return { tree: { ...tree, roots, nextId: id + 1 }, id }
}

/** A tool node under a specific container (a keyed sub-agent's tree id). */
export const onToolStartUnder = (
  tree: ExecutionTree,
  parentId: number,
  label: string,
  now: number,
): { tree: ExecutionTree; id: number } => {
  const id = tree.nextId
  const full: TreeNode = {
    id,
    kind: "tool",
    label,
    status: "running",
    startedAt: now,
    children: [],
  }
  return { tree: { ...tree, roots: appendChild(tree.roots, parentId, full), nextId: id + 1 }, id }
}

/** Find a sub-agent container by its persistent context-node id, anywhere. */
export const findByNodeId = (
  roots: ReadonlyArray<TreeNode>,
  nodeId: string,
): TreeNode | undefined => {
  for (const r of roots) {
    if (r.kind === "subagent" && r.nodeId === nodeId) return r
    const inner = findByNodeId(r.children, nodeId)
    if (inner !== undefined) return inner
  }
  return undefined
}

/** Stamp a sub-agent container's persistent context-node id after the fact —
 *  a history rebuild learns it from the run_agent RESULT, after the container
 *  was created from the call. */
export const onSubAgentNodeId = (
  tree: ExecutionTree,
  id: number,
  nodeId: string,
): ExecutionTree => ({
  ...tree,
  roots: mapRoots(tree.roots, id, (n) => ({ ...n, nodeId })),
})

/** Close a keyed sub-agent container by its tree id (parallel-safe). */
export const onSubAgentEndKeyed = (
  tree: ExecutionTree,
  id: number,
  ok: boolean,
  detail: string | undefined,
  now: number,
): ExecutionTree => closeNode(tree, id, ok ? "ok" : "error", detail, now)

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

/**
 * Close the ROOT turn's own spine (turns/tools) and collapse the open path —
 * but LEAVE running keyed sub-agent nodes (and their subtrees) open: in the
 * async fleet the root turn ends while background agents keep working, and
 * each has a GUARANTEED terminal `subagent_end` of its own now. The old
 * blanket "mark everything ok" painted still-running agents green the moment
 * the root turn ended — the execution tree and the DB-driven fleet tree then
 * contradicted each other.
 */
export const onAgentEnd = (
  tree: ExecutionTree,
  now: number,
): ExecutionTree => {
  const closeRunning = (n: TreeNode): TreeNode => {
    // A keyed sub-agent still running belongs to a live background fiber — its
    // own subagent_end will close it (and its subtree stays live with it).
    if (n.kind === "subagent" && n.status === "running" && n.nodeId !== undefined) {
      return n
    }
    const children = n.children.map(closeRunning)
    if (n.status === "running") {
      return { ...n, status: "ok", endedAt: now, children }
    }
    return { ...n, children }
  }
  return { ...tree, roots: tree.roots.map(closeRunning), openPath: [] }
}
