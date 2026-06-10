import { describe, expect, test } from "bun:test"
import type { AgentContextNode } from "@efferent/core"
import {
  buildNavRows,
  buildTreeRowsData,
  treeRowText,
  type TreeNodeDisplay,
  type TreeRowData,
} from "./contextTreeView.js"

/** Narrow a row's display to the node variant (throws on a conversation row). */
const disp = (r: TreeRowData): TreeNodeDisplay => {
  if (r.display.kind !== "node") throw new Error("expected a node row")
  return r.display
}

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
    expect(rows.map((r) => disp(r).folder)).toEqual(["a", "b", "c"])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 0])
    expect(rows.map((r) => r.head ?? false)).toEqual([true, false, true])
    expect(rows[0]!.foldId).toBe("tree:a") // has a child → foldable
    expect(rows[1]!.foldId).toBeUndefined() // leaf
  })

  test("folding a node hides its descendants", () => {
    const nodes = [node("a", null, "/ws/a", 1), node("b", "a", "/ws/a/b", 2)]
    const rows = buildTreeRowsData(nodes, new Set(["tree:a"]))
    expect(rows.map((r) => disp(r).folder)).toEqual(["a"])
    expect(disp(rows[0]!).folded).toBe(true)
  })

  test("a finished node stamped with another ref is stale; running/unstamped never are", () => {
    const nodes = [
      node("a", null, "/ws/a", 1, { workspaceRef: "old" }),
      node("b", null, "/ws/b", 2, { workspaceRef: "cur" }),
      node("c", null, "/ws/c", 3, { status: "running", workspaceRef: "old" }),
      node("d", null, "/ws/d", 4), // unstamped (non-git or pre-migration)
    ]
    const rows = buildTreeRowsData(nodes, new Set(), "cur")
    expect(rows.map((r) => disp(r).stale)).toEqual([true, false, false, false])
    // no current ref known → nothing is marked stale
    const without = buildTreeRowsData(nodes, new Set())
    expect(without.every((r) => !disp(r).stale)).toBe(true)
  })

  test("rails: roots bare, mid-children ├─, last children └─, continuation │", () => {
    // a → (b, c); b → d   (d sits under a non-last child → │ continuation)
    // e → f               (separate root tree; f under a last-ish lone child)
    const nodes = [
      node("a", null, "/ws/a", 1),
      node("b", "a", "/ws/b", 2),
      node("c", "a", "/ws/c", 3),
      node("d", "b", "/ws/d", 4),
      node("e", null, "/ws/e", 5),
      node("f", "e", "/ws/f", 6),
      node("g", "f", "/ws/g", 7),
    ]
    const rows = buildTreeRowsData(nodes, new Set())
    const rail = (folder: string) => {
      const r = rows.find((x) => disp(x).folder === folder)!
      return r.rail.prefix + r.rail.connector
    }
    expect(rail("a")).toBe("") // root: no rail
    expect(rail("b")).toBe("├─") // mid child
    expect(rail("d")).toBe("│ └─") // under a non-last child → continuation
    expect(rail("c")).toBe("└─") // last child
    expect(rail("e")).toBe("") // second root: fresh rail
    expect(rail("f")).toBe("└─") // only child
    expect(rail("g")).toBe("  └─") // under a last child → blank column
  })

  test("rails: folding one subtree leaves sibling rails unchanged", () => {
    const nodes = [
      node("a", null, "/ws/a", 1),
      node("b", "a", "/ws/b", 2),
      node("d", "b", "/ws/d", 3),
      node("c", "a", "/ws/c", 4),
    ]
    const open = buildTreeRowsData(nodes, new Set())
    const folded = buildTreeRowsData(nodes, new Set(["tree:b"]))
    const railOf = (rows: typeof open, folder: string) => {
      const r = rows.find((x) => disp(x).folder === folder)!
      return r.rail.prefix + r.rail.connector
    }
    expect(folded.map((r) => disp(r).folder)).toEqual(["a", "b", "c"]) // d hidden
    expect(railOf(folded, "b")).toBe(railOf(open, "b"))
    expect(railOf(folded, "c")).toBe(railOf(open, "c"))
  })

  test("siblings are ordered oldest-first; display carries status/edge/seed", () => {
    const nodes = [
      node("a", null, "/ws/a", 5, { status: "running" }),
      node("z", null, "/ws/z", 1, { edgeKind: "branched", returnSummary: "did x\nmore" }),
    ]
    const rows = buildTreeRowsData(nodes, new Set())
    expect(rows.map((r) => disp(r).folder)).toEqual(["z", "a"])
    expect(disp(rows[0]!).summary).toBe("did x") // first line only
    expect(disp(rows[1]!).status).toBe("running")
    expect(treeRowText(rows[0]!)).toContain("z")
  })
})

describe("buildNavRows (the navigator: conversations as roots)", () => {
  const convs = [
    { id: "c1", label: "Jun 9 · fix the bug", active: true },
    { id: "c2", label: "Jun 8 · add tests", active: false },
  ]

  test("conversations are the heads; each owns only its agent subtree at depth 1", () => {
    const nodes = [
      node("a", null, "/ws/a", 1, { rootConversationId: "c1" as never }),
      node("b", "a", "/ws/b", 2, { rootConversationId: "c1" as never }),
      node("x", null, "/ws/x", 3, { rootConversationId: "c2" as never }),
    ]
    const rows = buildNavRows(convs, nodes, new Set())
    expect(rows.map((r) => r.display.kind)).toEqual([
      "conversation",
      "node",
      "node",
      "conversation",
      "node",
    ])
    expect(rows.map((r) => r.head ?? false)).toEqual([true, false, false, true, false])
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 0, 1])
    // agent roots get rails relative to their conversation
    expect(rows[1]!.rail.connector).toBe("└─")
    const c1 = rows[0]!.display
    if (c1.kind !== "conversation") throw new Error("expected conversation")
    expect(c1.active).toBe(true)
    expect(c1.nodeCount).toBe(2) // whole subtree, all depths
    expect(rows[0]!.foldId).toBe("tree:conv:c1")
  })

  test("folding a conversation hides its agents; a node-less one isn't foldable", () => {
    const nodes = [node("a", null, "/ws/a", 1, { rootConversationId: "c1" as never })]
    const rows = buildNavRows(convs, nodes, new Set(["tree:conv:c1"]))
    expect(rows.map((r) => r.display.kind)).toEqual(["conversation", "conversation"])
    expect(rows[1]!.foldId).toBeUndefined() // c2 has no agents
    expect(treeRowText(rows[1]!)).toBe("Jun 8 · add tests")
  })

  test("no conversations → plain agent forest (the old :tree)", () => {
    const nodes = [node("a", null, "/ws/a", 1)]
    const rows = buildNavRows([], nodes, new Set())
    expect(rows.map((r) => r.display.kind)).toEqual(["node"])
    expect(rows[0]!.depth).toBe(0)
  })
})
