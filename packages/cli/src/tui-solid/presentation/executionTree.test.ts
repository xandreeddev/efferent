import { describe, expect, test } from "bun:test"
import {
  emptyTree,
  onSubAgentEndKeyed,
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
