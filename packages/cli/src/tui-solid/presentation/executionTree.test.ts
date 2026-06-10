import { describe, expect, test } from "bun:test"
import {
  emptyTree,
  onSubAgentEndKeyed,
  onRunEnd,
  onRunStart,
  onSubAgentStartKeyed,
  onToolStartUnder,
  onTurnStart,
  type ExecutionTree,
  type TreeNode,
} from "./executionTree.js"

const find = (roots: ReadonlyArray<TreeNode>, label: string): TreeNode | undefined => {
  for (const r of roots) {
    if (r.label === label) return r
    const inner = find(r.children, label)
    if (inner !== undefined) return inner
  }
  return undefined
}

describe("keyed sub-agent attribution (parallel fan-out)", () => {
  test("interleaved parallel runs stay siblings; tools land in the right container", () => {
    // turn 1 spawns A and B in parallel; their events interleave.
    let tree: ExecutionTree = onTurnStart(emptyTree, 0, 1)
    const a = onSubAgentStartKeyed(tree, "run_agent → a", undefined, 2)
    tree = a.tree
    const b = onSubAgentStartKeyed(tree, "run_agent → b", undefined, 3)
    tree = b.tree
    // interleaved: B's tool, then A's tool
    tree = onToolStartUnder(tree, b.id, "grep(b)", 4).tree
    tree = onToolStartUnder(tree, a.id, "read(a)", 5).tree
    // B finishes FIRST — the stack model would close A here.
    tree = onSubAgentEndKeyed(tree, b.id, true, "b done", 6)
    tree = onSubAgentEndKeyed(tree, a.id, false, "a failed", 7)

    const turn = tree.roots[0]!
    expect(turn.kind).toBe("turn")
    // siblings under the turn, never nested into each other
    expect(turn.children.map((c) => c.label)).toEqual(["run_agent → a", "run_agent → b"])
    const nodeA = find(tree.roots, "run_agent → a")!
    const nodeB = find(tree.roots, "run_agent → b")!
    expect(nodeA.children.map((c) => c.label)).toEqual(["read(a)"])
    expect(nodeB.children.map((c) => c.label)).toEqual(["grep(b)"])
    // ends pair by id, not by depth
    expect(nodeB.status).toBe("ok")
    expect(nodeA.status).toBe("error")
    expect(nodeA.detail).toBe("a failed")
  })

  test("a nested spawn anchors under its parent's container", () => {
    let tree: ExecutionTree = onTurnStart(emptyTree, 0, 1)
    const parent = onSubAgentStartKeyed(tree, "run_agent → adapters", undefined, 2)
    tree = parent.tree
    const child = onSubAgentStartKeyed(tree, "run_agent → auth", parent.id, 3)
    tree = child.tree
    const adapters = find(tree.roots, "run_agent → adapters")!
    expect(adapters.children.map((c) => c.label)).toEqual(["run_agent → auth"])
  })

  test("a human-driven resume (no open turn) lands at root, not inside stale state", () => {
    const { tree } = onSubAgentStartKeyed(emptyTree, "run_agent → auth", undefined, 1)
    expect(tree.roots.map((r) => r.label)).toEqual(["run_agent → auth"])
    expect(tree.openPath).toEqual([]) // never becomes the open container
  })
})

describe("run containers (per-user-message grouping)", () => {
  test("turns nest under the open run; a new run closes the previous one", () => {
    const r1 = onRunStart(emptyTree, "fix the bug", 1)
    let tree = onTurnStart(r1.tree, 0, 2)
    tree = onTurnStart(tree, 1, 3)
    const r2 = onRunStart(tree, "now add tests", 4)
    tree = onTurnStart(r2.tree, 0, 5)

    expect(tree.roots.map((r) => r.label)).toEqual(["fix the bug", "now add tests"])
    const run1 = find(tree.roots, "fix the bug")!
    expect(run1.kind).toBe("run")
    expect(run1.status).toBe("ok") // closed by the second run's start
    expect(run1.children.map((c) => c.label)).toEqual(["turn 1", "turn 2"])
    const run2 = find(tree.roots, "now add tests")!
    expect(run2.status).toBe("running")
    expect(run2.children.map((c) => c.label)).toEqual(["turn 1"])
  })

  test("onRunEnd seals the run and any still-open descendants (interrupt path)", () => {
    const r = onRunStart(emptyTree, "long task", 1)
    let tree = onTurnStart(r.tree, 0, 2)
    tree = onRunEnd(tree, true, 3)
    const run = find(tree.roots, "long task")!
    expect(run.status).toBe("ok")
    expect(run.children[0]!.status).toBe("ok")
    expect(tree.openPath).toEqual([])
  })

  test("onRunEnd is a no-op when no run is open (preview-driven turns)", () => {
    const tree = onTurnStart(emptyTree, 0, 1)
    expect(onRunEnd(tree, true, 2)).toBe(tree)
  })

  test("a keyed spawn anchors under the open run's turn", () => {
    const r = onRunStart(emptyTree, "spawn stuff", 1)
    const tree = onTurnStart(r.tree, 0, 2)
    const spawned = onSubAgentStartKeyed(tree, "run_agent → auth", undefined, 3)
    const turn = find(spawned.tree.roots, "turn 1")!
    expect(turn.children.map((c) => c.label)).toEqual(["run_agent → auth"])
  })
})
