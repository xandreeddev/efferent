import { describe, expect, test } from "bun:test"
import type { AgentMessage, Checkpoint, ConversationId } from "@agent/core"
import { buildContextView, type ContextRow } from "./contextView.js"
import {
  contextRows,
  emptySidePane,
  sideToggleSelect,
  stackCursorMove,
  stackCursorToTop,
  stackRows,
  stackToggle,
  type SidePaneState,
} from "./sidePane.js"
import { emptyTree, onToolEnd, onToolStart, onTurnStart } from "./executionTree.js"

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
const baseState = (): SidePaneState => ({
  ...emptySidePane,
  view: "context",
  context: buildContextView(msgs, [cp(1, "S1")]),
})

/** Put the cursor on the first row matching `pred`, then return the state. */
const cursorOn = (
  state: SidePaneState,
  pred: (r: ContextRow) => boolean,
): SidePaneState => {
  const idx = contextRows(state).findIndex(pred)
  expect(idx).toBeGreaterThanOrEqual(0)
  return { ...state, contextCursor: idx }
}

const onHandoff = (s: SidePaneState, h: number) =>
  cursorOn(s, (r) => r.kind === "segment" && r.handoffIndex === h)
const onTurn = (s: SidePaneState, t: number) =>
  cursorOn(s, (r) => r.kind === "turn" && r.turnIndex === t)

describe("sideToggleSelect — handoffs and turns are mutually exclusive", () => {
  test("Space on a handoff row selects the handoff", () => {
    const s = sideToggleSelect(onHandoff(baseState(), 1))
    expect([...s.contextHandoffSelected]).toEqual([1])
    expect([...s.contextSelected]).toEqual([])
  })

  test("selecting a handoff clears its already-selected inner turns", () => {
    // select inner turn 0 (belongs to handoff #1), then select the handoff
    const withTurn = sideToggleSelect(onTurn(baseState(), 0))
    expect([...withTurn.contextSelected]).toEqual([0])
    const withHandoff = sideToggleSelect(onHandoff(withTurn, 1))
    expect([...withHandoff.contextHandoffSelected]).toEqual([1])
    expect([...withHandoff.contextSelected]).toEqual([]) // turn 0 dropped
  })

  test("selecting an inner turn clears its already-selected handoff", () => {
    const withHandoff = sideToggleSelect(onHandoff(baseState(), 1))
    const withTurn = sideToggleSelect(onTurn(withHandoff, 0))
    expect([...withTurn.contextSelected]).toEqual([0])
    expect([...withTurn.contextHandoffSelected]).toEqual([]) // handoff #1 dropped
  })

  test("loaded-segment turns are unaffected by a selected handoff", () => {
    // turn 2 is [e] in the loaded segment — owns no handoff
    const withHandoff = sideToggleSelect(onHandoff(baseState(), 1))
    const both = sideToggleSelect(onTurn(withHandoff, 2))
    expect([...both.contextHandoffSelected]).toEqual([1])
    expect([...both.contextSelected]).toEqual([2])
  })

  test("toggling a selected handoff off deselects it", () => {
    const on = sideToggleSelect(onHandoff(baseState(), 1))
    const off = sideToggleSelect(onHandoff(on, 1))
    expect([...off.contextHandoffSelected]).toEqual([])
  })
})

describe("Activity (stack) view navigation", () => {
  test("stackRows exposes the foldable section headers", () => {
    const ids = stackRows(emptySidePane)
      .map((r) => r.foldId)
      .filter((x): x is string => x !== undefined)
    expect(ids).toEqual(["files", "skills", "instructions"])
  })

  test("Tab on a section header toggles its collapsed state", () => {
    const rows = stackRows(emptySidePane)
    const i = rows.findIndex((r) => r.foldId === "skills")
    expect(i).toBeGreaterThanOrEqual(0)
    expect(emptySidePane.stackCollapsed.has("skills")).toBe(true)
    const opened = stackToggle({ ...emptySidePane, stackCursor: i })
    expect(opened.stackCollapsed.has("skills")).toBe(false)
    const closed = stackToggle({ ...opened, stackCursor: i })
    expect(closed.stackCollapsed.has("skills")).toBe(true)
  })

  test("toggling off a row that isn't a fold row is a no-op", () => {
    // stats header (row 0) has no foldId
    const same = stackToggle({ ...emptySidePane, stackCursor: 0 })
    expect([...same.stackCollapsed].sort()).toEqual(["files", "instructions", "skills"])
  })

  test("a turn node is foldable; collapsing it hides its tool children", () => {
    let tree = onTurnStart(emptyTree, 0, 0) // turn id 1
    const started = onToolStart(tree, "Read(x.ts)", 0) // tool id 2
    tree = onToolEnd(started.tree, started.id, true, "1 line", 0)
    const base: SidePaneState = { ...emptySidePane, tree }
    const rows = stackRows(base)
    const turnRow = rows.findIndex((r) => r.foldId === "node:1")
    expect(turnRow).toBeGreaterThanOrEqual(0)
    expect(rows.some((r) => r.line.includes("Read(x.ts)"))).toBe(true) // tool visible
    const folded = stackToggle({ ...base, stackCursor: turnRow })
    expect(folded.stackCollapsed.has("node:1")).toBe(true)
    expect(stackRows(folded).some((r) => r.line.includes("Read(x.ts)"))).toBe(false) // hidden
  })

  test("cursor moves clamp to the row range", () => {
    const n = stackRows(emptySidePane).length
    const bottom = stackCursorMove(emptySidePane, 1000)
    expect(bottom.stackCursor).toBe(n - 1)
    expect(stackCursorToTop(bottom).stackCursor).toBe(0)
  })
})
