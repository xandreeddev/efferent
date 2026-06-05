import { describe, expect, test } from "bun:test"
import type { AgentMessage, Checkpoint, ConversationId } from "@efferent/core"
import type { ExecutionTree, TreeNode } from "./executionTree.js"
import { buildContextView, type ContextRowData } from "./contextView.js"
import {
  buildStackRowsData,
  contextRows,
  emptyNav,
  emptyProjection,
  sideToggleSelect,
  stackFold,
  stackMessage,
  stackParagraph,
  type SidePaneNav,
  type SidePaneProjection,
} from "./sidePane.js"

const user = (text: string): AgentMessage => ({ role: "user", content: text })
const assistant = (text: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})
const cp = (messagePosition: number, summary: string): Checkpoint => ({
  id: "00000000-0000-0000-0000-000000000000",
  conversationId: "11111111-1111-1111-1111-111111111111" as ConversationId,
  messagePosition,
  summary,
  createdAt: 0,
})

// 0..4 ; cp folds [a,b] as handoff #1; loaded turns are 1 ([c,d]) and 2 ([e]).
const msgs = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")]
// The reducers read the segments from the projection; selection/cursor live in nav.
const projection: SidePaneProjection = {
  ...emptyProjection,
  context: buildContextView(msgs, [cp(1, "S1")]),
}
const baseNav = (): SidePaneNav => ({ ...emptyNav, view: "context" })

/** Put the nav cursor on the first row matching `pred`, then return the nav. */
const cursorOn = (nav: SidePaneNav, pred: (r: ContextRowData) => boolean): SidePaneNav => {
  const idx = contextRows(nav, projection).findIndex(pred)
  expect(idx).toBeGreaterThanOrEqual(0)
  return { ...nav, contextCursor: idx }
}

const onHandoff = (nav: SidePaneNav, h: number) =>
  cursorOn(nav, (r) => r.kind === "segment" && r.handoffIndex === h)
const onTurn = (nav: SidePaneNav, t: number) =>
  cursorOn(nav, (r) => r.kind === "turn" && r.turnIndex === t)

const toggle = (nav: SidePaneNav): SidePaneNav => sideToggleSelect(nav, projection)

describe("sideToggleSelect — handoffs and turns are mutually exclusive", () => {
  test("Space on a handoff row selects the handoff", () => {
    const s = toggle(onHandoff(baseNav(), 1))
    expect([...s.contextHandoffSelected]).toEqual([1])
    expect([...s.contextSelected]).toEqual([])
  })

  test("selecting a handoff clears its already-selected inner turns", () => {
    // select inner turn 0 (belongs to handoff #1), then select the handoff
    const withTurn = toggle(onTurn(baseNav(), 0))
    expect([...withTurn.contextSelected]).toEqual([0])
    const withHandoff = toggle(onHandoff(withTurn, 1))
    expect([...withHandoff.contextHandoffSelected]).toEqual([1])
    expect([...withHandoff.contextSelected]).toEqual([]) // turn 0 dropped
  })

  test("selecting an inner turn clears its already-selected handoff", () => {
    const withHandoff = toggle(onHandoff(baseNav(), 1))
    const withTurn = toggle(onTurn(withHandoff, 0))
    expect([...withTurn.contextSelected]).toEqual([0])
    expect([...withTurn.contextHandoffSelected]).toEqual([]) // handoff #1 dropped
  })

  test("loaded-segment turns are unaffected by a selected handoff", () => {
    // turn 2 is [e] in the loaded segment — owns no handoff
    const withHandoff = toggle(onHandoff(baseNav(), 1))
    const both = toggle(onTurn(withHandoff, 2))
    expect([...both.contextHandoffSelected]).toEqual([1])
    expect([...both.contextSelected]).toEqual([2])
  })

  test("toggling a selected handoff off deselects it", () => {
    const on = toggle(onHandoff(baseNav(), 1))
    const off = toggle(onHandoff(on, 1))
    expect([...off.contextHandoffSelected]).toEqual([])
  })
})

// --- Activity (stack) view ---

const tool = (id: number, label: string): TreeNode => ({
  id,
  kind: "tool",
  label,
  status: "ok",
  startedAt: 0,
  endedAt: 0,
  children: [],
})
const turnNode = (id: number, label: string, children: ReadonlyArray<TreeNode>): TreeNode => ({
  id,
  kind: "turn",
  label,
  status: "ok",
  startedAt: 0,
  endedAt: 0,
  children,
})
const tree: ExecutionTree = {
  roots: [turnNode(1, "turn 1", [tool(2, "read_file"), tool(3, "edit_file")])],
  openPath: [],
  nextId: 4,
}
const stackProjection: SidePaneProjection = {
  ...emptyProjection,
  tree,
  skillsLoaded: ["spike-notes"],
  filesChanged: [{ path: "/a/b.ts", added: 3, removed: 1 }],
}

describe("buildStackRowsData", () => {
  test("flattens tree (expanded) + the three section headers, marking heads", () => {
    const rows = buildStackRowsData(stackProjection, new Set())
    expect(rows.map((r) => r.key)).toEqual([
      "stack:node:1",
      "stack:node:2",
      "stack:node:3",
      "stack:section:files",
      "stack:file:0",
      "stack:section:skills",
      "stack:skill:0",
      "stack:section:instructions",
    ])
    // heads = the tree root + the three section headers (the [] stops)
    expect(rows.filter((r) => r.head).map((r) => r.key)).toEqual([
      "stack:node:1",
      "stack:section:files",
      "stack:section:skills",
      "stack:section:instructions",
    ])
    // foldable rows carry the foldId the cursor toggles
    expect(rows.find((r) => r.key === "stack:node:1")?.foldId).toBe("node:1")
    expect(rows.find((r) => r.key === "stack:section:files")?.foldId).toBe("files")
    expect(rows.find((r) => r.key === "stack:node:2")?.foldId).toBeUndefined()
  })

  test("a folded tree container hides its children", () => {
    const rows = buildStackRowsData(stackProjection, new Set(["node:1"]))
    expect(rows.some((r) => r.key === "stack:node:2")).toBe(false)
    expect(rows.find((r) => r.key === "stack:node:1")?.display).toMatchObject({ folded: true })
  })

  test("a folded section header hides its child rows", () => {
    const rows = buildStackRowsData(stackProjection, new Set(["files"]))
    expect(rows.some((r) => r.key === "stack:file:0")).toBe(false)
  })
})

describe("Activity cursor motions", () => {
  // Sections expanded so the row indices below are stable and obvious.
  const nav = (over: Partial<SidePaneNav> = {}): SidePaneNav => ({
    ...emptyNav,
    stackCollapsed: new Set(),
    ...over,
  })

  test("stackParagraph steps one row, clamped", () => {
    expect(stackParagraph(nav({ stackCursor: 0 }), stackProjection, 1).stackCursor).toBe(1)
    expect(stackParagraph(nav({ stackCursor: 0 }), stackProjection, -1).stackCursor).toBe(0)
  })

  test("stackMessage jumps head-to-head (root → files header at index 3)", () => {
    // rows: 0 node1(head) 1 node2 2 node3 3 files(head) 4 file0 5 skills(head) ...
    expect(stackMessage(nav({ stackCursor: 0 }), stackProjection, 1).stackCursor).toBe(3)
    expect(stackMessage(nav({ stackCursor: 4 }), stackProjection, -1).stackCursor).toBe(3)
  })

  test("stackFold toggles the container under the cursor", () => {
    const folded = stackFold(nav({ stackCursor: 0 }), stackProjection)
    expect([...folded.stackCollapsed]).toContain("node:1")
    // a leaf row (node:2 at index 1) is a no-op
    const onLeaf = stackFold(nav({ stackCursor: 1 }), stackProjection)
    expect(onLeaf.stackCollapsed.has("node:2")).toBe(false)
  })
})
