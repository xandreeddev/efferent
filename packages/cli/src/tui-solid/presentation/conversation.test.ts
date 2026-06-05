import { describe, expect, test } from "bun:test"
import {
  buildConversation,
  buildConversationRows,
  foldableIds,
  type ScrollbackBlock,
} from "./conversation.js"

const tool = (id: string, name: string): ScrollbackBlock => ({
  kind: "tool",
  id,
  toolName: name,
  state: "ok",
})

const turnWithThreeTools = (): ScrollbackBlock[] => [
  { kind: "user", text: "do the thing" },
  { kind: "assistant", text: "on it" },
  tool("1", "read a"),
  tool("2", "edit b"),
  tool("3", "bash c"),
]

describe("buildConversation — turn/tool-group structure", () => {
  test("a user-led turn carries its subject, step count, and grouped body", () => {
    const items = buildConversation(turnWithThreeTools())
    expect(items).toHaveLength(1)
    const turn = items[0]!
    expect(turn.kind).toBe("turn")
    if (turn.kind !== "turn") throw new Error("expected turn")
    expect(turn.subject).toBe("do the thing")
    expect(turn.steps).toBe(4) // assistant + 3 tools (matches "· N steps")
    // body = assistant prose, then a single tool group of the 3 tools
    expect(turn.body).toHaveLength(2)
    expect(turn.body[0]).toEqual({
      kind: "block",
      id: "b:1",
      block: { kind: "assistant", text: "on it" },
    })
    const group = turn.body[1]!
    expect(group.kind).toBe("toolGroup")
    if (group.kind !== "toolGroup") throw new Error("expected toolGroup")
    expect(group.tools).toHaveLength(3)
  })

  test("a run of <2 tools stays inline (no group)", () => {
    const items = buildConversation([
      { kind: "user", text: "one tool" },
      tool("1", "read a"),
    ])
    const turn = items[0]!
    if (turn.kind !== "turn") throw new Error("expected turn")
    expect(turn.body).toHaveLength(1)
    expect(turn.body[0]!.kind).toBe("block")
  })

  test("tool-group id is keyed on the first member, so streaming keeps it stable", () => {
    const base = turnWithThreeTools()
    const before = buildConversation(base)
    const beforeTurn = before[0]!
    if (beforeTurn.kind !== "turn") throw new Error("expected turn")
    const gid = (beforeTurn.body[1] as { id: string }).id
    expect(gid).toBe("grp:1")

    // A 4th tool streams into the same turn.
    const after = buildConversation([...base, tool("4", "grep d")])
    const afterTurn = after[0]!
    if (afterTurn.kind !== "turn") throw new Error("expected turn")
    const group = afterTurn.body[1]!
    if (group.kind !== "toolGroup") throw new Error("expected toolGroup")
    expect(group.id).toBe("grp:1") // unchanged → fold survives
    expect(group.tools).toHaveLength(4) // count bumped
  })

  test("turn id is stable across an in-place tool update (same indices)", () => {
    const a = buildConversation(turnWithThreeTools())
    // Replace tool "2" with a finished version (same id) — indices unchanged.
    const updated = turnWithThreeTools()
    updated[3] = { kind: "tool", id: "2", toolName: "edit b", state: "ok", detail: "+1/-0" }
    const b = buildConversation(updated)
    expect((a[0] as { id: string }).id).toBe("turn:0")
    expect((b[0] as { id: string }).id).toBe("turn:0")
  })
})

describe("foldableIds", () => {
  test("lists each turn id and tool-group id in render order", () => {
    const items = buildConversation(turnWithThreeTools())
    expect(foldableIds(items)).toEqual(["turn:0", "grp:1"])
  })

  test("checkpoints are not foldable; loose tool groups are", () => {
    const items = buildConversation([
      { kind: "checkpoint", text: "summary" },
      tool("9", "read x"),
      tool("10", "read y"),
    ])
    // checkpoint item + a loose run with one tool group
    expect(foldableIds(items)).toEqual(["grp:9"])
  })
})

describe("buildConversationRows — the fold-cursor row list", () => {
  test("turn header + its body rows; the header is a foldable head, bodies aren't", () => {
    const rows = buildConversationRows(buildConversation(turnWithThreeTools()), new Set())
    expect(rows.map((r) => r.key)).toEqual(["turn:0", "b:1", "grp:1"])
    // turn header: head + foldable; assistant block: plain; tool group: foldable
    expect(rows[0]).toMatchObject({ key: "turn:0", foldId: "turn:0", head: true })
    expect(rows[1]).toMatchObject({ key: "b:1", head: false })
    expect(rows[1]!.foldId).toBeUndefined()
    expect(rows[2]).toMatchObject({ key: "grp:1", foldId: "grp:1", head: false })
  })

  test("a folded turn hides its body rows (just the header remains)", () => {
    const rows = buildConversationRows(buildConversation(turnWithThreeTools()), new Set(["turn:0"]))
    expect(rows.map((r) => r.key)).toEqual(["turn:0"])
  })

  test("checkpoints and loose-run starts are heads (the [] stops)", () => {
    const rows = buildConversationRows(
      buildConversation([
        { kind: "checkpoint", text: "summary" },
        tool("9", "read x"),
        tool("10", "read y"),
      ]),
      new Set(),
    )
    // checkpoint head, then the loose run's single tool group (its first row a head)
    expect(rows.map((r) => ({ key: r.key, head: r.head ?? false }))).toEqual([
      { key: "b:0", head: true },
      { key: "grp:9", head: true },
    ])
  })
})
