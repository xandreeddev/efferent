import { describe, expect, test } from "bun:test"
import type { AgentMessage, Checkpoint, ConversationId } from "@efferent/core"
import { buildContextView, type ContextRowData } from "./contextView.js"
import {
  contextRows,
  emptyNav,
  emptyProjection,
  sideToggleSelect,
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
