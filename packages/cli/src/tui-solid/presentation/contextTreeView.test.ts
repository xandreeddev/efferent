import { describe, expect, test } from "bun:test"
import type { AgentContextNode } from "@efferent/core"
import { buildTreeRowsData, treeRowText } from "./contextTreeView.js"

const node = (
  id: string,
  parentId: string | null,
  folder: string,
  createdAt: number,
  extra: Partial<AgentContextNode> = {},
): AgentContextNode =>
  ({
    id,
    parentId,
    rootConversationId: null,
    edgeKind: "spawned",
    folder,
    displayRoot: "/ws",
    seed: { kind: "task" },
    status: "ok",
    filesChanged: [],
    createdAt,
    ...extra,
  }) as AgentContextNode

describe("buildTreeRowsData", () => {
  test("reconstructs parent/child order with depth, head, and fold ids", () => {
    const nodes = [
      node("a", null, "/ws/a", 1),
      node("b", "a", "/ws/a/b", 2),
      node("c", null, "/ws/c", 3),
    ]
    const rows = buildTreeRowsData(nodes, new Set())
    expect(rows.map((r) => r.display.folder)).toEqual(["a", "b", "c"])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0])
    expect(rows.map((r) => r.head ?? false)).toEqual([true, false, true])
    expect(rows[0]!.foldId).toBe("tree:a") // has a child → foldable
    expect(rows[1]!.foldId).toBeUndefined() // leaf
  })

  test("folding a node hides its descendants", () => {
    const nodes = [node("a", null, "/ws/a", 1), node("b", "a", "/ws/a/b", 2)]
    const rows = buildTreeRowsData(nodes, new Set(["tree:a"]))
    expect(rows.map((r) => r.display.folder)).toEqual(["a"])
    expect(rows[0]!.display.folded).toBe(true)
  })

  test("a finished node stamped with another ref is stale; running/unstamped never are", () => {
    const nodes = [
      node("a", null, "/ws/a", 1, { workspaceRef: "old" }),
      node("b", null, "/ws/b", 2, { workspaceRef: "cur" }),
      node("c", null, "/ws/c", 3, { status: "running", workspaceRef: "old" }),
      node("d", null, "/ws/d", 4), // unstamped (non-git or pre-migration)
    ]
    const rows = buildTreeRowsData(nodes, new Set(), "cur")
    expect(rows.map((r) => r.display.stale)).toEqual([true, false, false, false])
    // no current ref known → nothing is marked stale
    const without = buildTreeRowsData(nodes, new Set())
    expect(without.every((r) => !r.display.stale)).toBe(true)
  })

  test("siblings are ordered oldest-first; display carries status/edge/seed", () => {
    const nodes = [
      node("a", null, "/ws/a", 5, { status: "running" }),
      node("z", null, "/ws/z", 1, { edgeKind: "branched", returnSummary: "did x\nmore" }),
    ]
    const rows = buildTreeRowsData(nodes, new Set())
    expect(rows.map((r) => r.display.folder)).toEqual(["z", "a"])
    expect(rows[0]!.display.summary).toBe("did x") // first line only
    expect(rows[1]!.display.status).toBe("running")
    expect(treeRowText(rows[0]!)).toContain("z")
  })
})
