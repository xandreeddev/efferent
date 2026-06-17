import { describe, expect, test } from "bun:test"
import type { AgentMessage, Checkpoint, ConversationId } from "@xandreed/sdk-core"
import {
  buildContextRowsData,
  buildContextView,
  messagesForSelectedTurns,
  turnIdsOf,
  type ContextRowData,
  type ContextSegment,
} from "./contextView.js"

const user = (text: string): AgentMessage => ({ role: "user", content: text })
const assistant = (text: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

// Test fixture: buildContextView only reads `messagePosition` + `summary`.
const cp = (messagePosition: number, summary: string): Checkpoint => ({
  id: "00000000-0000-0000-0000-000000000000",
  conversationId: "11111111-1111-1111-1111-111111111111" as ConversationId,
  messagePosition,
  summary,
  createdAt: 0,
})

const loaded = (segs: ReadonlyArray<ContextSegment>) =>
  segs.find((s) => s.kind === "loaded") as Extract<ContextSegment, { kind: "loaded" }>
const archived = (segs: ReadonlyArray<ContextSegment>) =>
  segs.filter((s): s is Extract<ContextSegment, { kind: "archived" }> => s.kind === "archived")

describe("buildContextView", () => {
  test("no checkpoints → everything loaded, no summary", () => {
    const msgs = [user("a"), assistant("b"), user("c")]
    const segs = buildContextView(msgs, [])
    expect(segs).toHaveLength(1)
    expect(loaded(segs).summary).toBeUndefined()
    expect(loaded(segs).messages).toHaveLength(3)
    expect(archived(segs)).toHaveLength(0)
  })

  test("one checkpoint folds messages up to its position into archived", () => {
    // positions: 0=a 1=b 2=c 3=d ; checkpoint at position 1 folds [a, b]
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d")]
    const segs = buildContextView(msgs, [cp(1, "SUMMARY")])
    const arch = archived(segs)
    expect(arch).toHaveLength(1)
    expect(arch[0]!.handoffIndex).toBe(1)
    expect(arch[0]!.summary).toBe("SUMMARY") // archived segment carries its checkpoint summary
    expect(arch[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    const ld = loaded(segs)
    expect(ld.summary).toBe("SUMMARY")
    expect(ld.messages).toHaveLength(2) // c, d
  })

  test("each archived segment carries its own checkpoint summary", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")]
    const segs = buildContextView(msgs, [cp(1, "S1"), cp(3, "S2")])
    expect(archived(segs).map((s) => s.summary)).toEqual(["S1", "S2"])
  })

  test("folding everything → loaded is summary-only", () => {
    const msgs = [user("a"), assistant("b")]
    const segs = buildContextView(msgs, [cp(1, "ALL")])
    expect(loaded(segs).summary).toBe("ALL")
    expect(loaded(segs).messages).toHaveLength(0)
    expect(archived(segs)[0]!.messages).toHaveLength(2)
  })

  test("two checkpoints → two archived segments + loaded carries the latest summary", () => {
    // 0..4 ; cp1 folds 0..1, cp2 folds 2..3, loaded = [4]
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")]
    const segs = buildContextView(msgs, [cp(1, "S1"), cp(3, "S2")])
    const arch = archived(segs)
    expect(arch).toHaveLength(2)
    expect(arch[0]!.messages).toHaveLength(2) // a, b
    expect(arch[1]!.messages).toHaveLength(2) // c, d
    expect(arch[1]!.handoffIndex).toBe(2)
    const ld = loaded(segs)
    expect(ld.summary).toBe("S2") // latest summary is what's loaded
    expect(ld.messages).toHaveLength(1) // e
  })

  test("checkpoints are sorted by position regardless of input order", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")]
    const segs = buildContextView(msgs, [cp(3, "S2"), cp(1, "S1")])
    expect(loaded(segs).summary).toBe("S2")
    expect(archived(segs).map((s) => s.messages.length)).toEqual([2, 2])
  })
})

describe("buildContextRowsData — rows", () => {
  const msgRows = (rows: ReadonlyArray<ContextRowData>) => rows.filter((r) => r.kind === "message")

  test("no checkpoints → header + loaded segment + message rows with positions", () => {
    const rows = buildContextRowsData(
      buildContextView([user("a"), assistant("b"), user("c")], []),
      new Set(),
    )
    expect(msgRows(rows).map((r) => r.messageIndex)).toEqual([0, 1, 2])
    expect(rows.some((r) => r.kind === "segment" && r.collapsible)).toBe(true)
  })

  test("a collapsed segment emits only its header (no message rows)", () => {
    const rows = buildContextRowsData(
      buildContextView([user("a"), assistant("b")], []),
      new Set(["seg:loaded"]),
    )
    expect(msgRows(rows)).toHaveLength(0)
    expect(rows.find((r) => r.kind === "segment")?.groupId).toBe("seg:loaded")
  })

  test("message indices stay continuous across archived + loaded segments", () => {
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")]
    const rows = buildContextRowsData(buildContextView(msgs, [cp(1, "S")]), new Set())
    expect(msgRows(rows).map((r) => r.messageIndex)).toEqual([0, 1, 2, 3, 4])
  })

  test("an archived segment carries its handoffIndex and a ✦ summary preview row", () => {
    const msgs = [user("a"), assistant("b"), user("c")]
    const rows = buildContextRowsData(buildContextView(msgs, [cp(1, "THE SUMMARY")]), new Set())
    expect(rows.some((r) => r.kind === "segment" && r.handoffIndex === 1)).toBe(true)
    expect(
      rows.some((r) => r.display.kind === "summary" && r.display.text.includes("THE SUMMARY")),
    ).toBe(true)
  })

  test("a selected handoff marks its segment row selected and counts in the header", () => {
    const msgs = [user("a"), assistant("b"), user("c")]
    const segs = buildContextView(msgs, [cp(1, "S")])
    const rows = buildContextRowsData(segs, new Set(), new Set(), new Set([1]))
    const seg = rows.find((r) => r.kind === "segment" && r.handoffIndex === 1)
    expect(seg).toBeDefined()
    const segDisplay = seg!.display
    expect(segDisplay.kind === "segment" && segDisplay.selected).toBe(true)
    const header = rows[0]!.display
    expect(header.kind === "header" && header.selectedCount).toBe(1)
  })

  test("display payload carries the un-styled text (no ANSI escapes)", () => {
    const segs = buildContextView([user("hello world"), assistant("hi")], [])
    const data = buildContextRowsData(segs, new Set())
    const turn = data.find((r) => r.kind === "turn")
    expect(turn?.display.kind).toBe("turn")
    if (turn?.display.kind === "turn") {
      expect(turn.display.subject).toBe("hello world")
      expect(turn.display.subject).not.toContain("\x1b")
    }
  })
})

const toolCall = (id: string, name: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "tool-call", toolCallId: id, toolName: name, input: {} }],
})
const toolResult = (id: string, name: string): AgentMessage => ({
  role: "tool",
  content: [{ type: "tool-result", toolCallId: id, toolName: name, output: {}, isError: false }],
})

describe("turn grouping", () => {
  test("each user message starts a turn; turnIdsOf counts them across segments", () => {
    // 2 turns: [u,a] and [u,a]
    const msgs = [user("hi"), assistant("yo"), user("again"), assistant("sure")]
    expect(turnIdsOf(buildContextView(msgs, []))).toEqual(["turn:0", "turn:1"])
  })

  test("buildContextRowsData emits one turn row per turn with a running turnIndex", () => {
    const msgs = [user("a"), assistant("A"), user("b"), assistant("B")]
    const rows = buildContextRowsData(buildContextView(msgs, []), new Set())
    const turns = rows.filter((r) => r.kind === "turn")
    expect(turns.map((t) => t.turnIndex)).toEqual([0, 1])
    // turn rows carry the first message index of the turn (jump target)
    expect(turns.map((t) => t.messageIndex)).toEqual([0, 2])
    expect(turns.every((t) => t.collapsible)).toBe(true)
  })

  test("a folded turn hides its child message rows; the turn row stays", () => {
    const msgs = [user("a"), assistant("A"), user("b"), assistant("B")]
    const rows = buildContextRowsData(buildContextView(msgs, []), new Set(["turn:0"]))
    expect(rows.filter((r) => r.kind === "turn")).toHaveLength(2)
    // turn:0 folded → its messages absent; turn:1 expanded → its messages present
    const msgIdxs = rows.filter((r) => r.kind === "message").map((r) => r.messageIndex)
    expect(msgIdxs).toEqual([2, 3])
  })

  test("selected turns are marked selected and the header shows a count", () => {
    const msgs = [user("a"), assistant("A"), user("b"), assistant("B")]
    const rows = buildContextRowsData(buildContextView(msgs, []), new Set(), new Set([1]))
    const turns = rows.filter((r) => r.kind === "turn")
    const d0 = turns[0]!.display
    const d1 = turns[1]!.display
    expect(d0.kind === "turn" && d0.selected).toBe(false)
    expect(d1.kind === "turn" && d1.selected).toBe(true)
    const header = rows[0]!.display
    expect(header.kind === "header" && header.selectedCount).toBe(1)
  })
})

describe("messagesForSelectedTurns", () => {
  test("collects the selected turns' messages in order", () => {
    const msgs = [user("a"), assistant("A"), user("b"), assistant("B")]
    const segs = buildContextView(msgs, [])
    const picked = messagesForSelectedTurns(segs, new Set([1]))
    expect(picked).toHaveLength(2)
    expect(picked[0]).toEqual(user("b"))
  })

  test("keeps a tool-call and its tool-result together (turn integrity)", () => {
    // one turn: user → assistant(tool-call) → tool(result)
    const msgs = [user("read it"), toolCall("t1", "read_file"), toolResult("t1", "read_file")]
    const segs = buildContextView(msgs, [])
    const picked = messagesForSelectedTurns(segs, new Set([0]))
    expect(picked.map((m) => m.role)).toEqual(["user", "assistant", "tool"])
  })

  test("nothing selected → empty", () => {
    const msgs = [user("a"), assistant("A")]
    expect(messagesForSelectedTurns(buildContextView(msgs, []), new Set())).toEqual([])
  })

  test("a selected handoff yields a single summary message before any selected turns", () => {
    // cp folds [a,b] (handoff #1); loaded has turns 1 ([c,d]) and 2 ([e])
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")]
    const segs = buildContextView(msgs, [cp(1, "S1")])
    // select handoff #1 + loaded turn 2 ([e])
    const picked = messagesForSelectedTurns(segs, new Set([2]), new Set([1]))
    expect(picked).toHaveLength(2)
    expect(picked[0]!.role).toBe("user") // synthetic handoff summary message
    expect(typeof picked[0]!.content === "string" && picked[0]!.content.includes("S1")).toBe(true)
    expect(picked[1]).toEqual(user("e"))
  })

  test("selecting only a handoff yields just its summary (not the folded messages)", () => {
    const msgs = [user("a"), assistant("b"), user("c")]
    const segs = buildContextView(msgs, [cp(1, "ONLY SUMMARY")])
    const picked = messagesForSelectedTurns(segs, new Set(), new Set([1]))
    expect(picked).toHaveLength(1)
    expect(picked[0]!.role).toBe("user")
    expect(typeof picked[0]!.content === "string" && picked[0]!.content.includes("ONLY SUMMARY")).toBe(
      true,
    )
  })

  test("turn indices line up across archived + loaded", () => {
    // 0..4 ; cp folds 0..1 (archived turn 0), loaded has turns 1 ([c,d]) and 2 ([e])
    const msgs = [user("a"), assistant("b"), user("c"), assistant("d"), user("e")]
    const segs = buildContextView(msgs, [cp(1, "S")])
    const rows = buildContextRowsData(segs, new Set())
    expect(rows.filter((r) => r.kind === "turn").map((t) => t.turnIndex)).toEqual([0, 1, 2])
    // selecting turn 2 yields just [e]
    expect(messagesForSelectedTurns(segs, new Set([2]))).toEqual([user("e")])
  })
})
