import { describe, expect, test } from "bun:test"
import type { AgentMessage, Checkpoint, ConversationId } from "@agent/core"
import { buildContextView, type ContextSegment } from "./contextView.js"

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
    expect(arch[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    const ld = loaded(segs)
    expect(ld.summary).toBe("SUMMARY")
    expect(ld.messages).toHaveLength(2) // c, d
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
