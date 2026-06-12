import { describe, expect, test } from "bun:test"
import { FastCheck as fc } from "effect"
import {
  buildConversation,
  buildConversationRows,
  foldIdsByKind,
  searchConversation,
  splitByMatch,
  toolGroupExpanded,
  toolGroupState,
  toolGroupSummary,
  type ScrollbackBlock,
  type ToolBlock,
  type ToolPillState,
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

describe("foldIdsByKind", () => {
  test("splits turn ids from tool-group ids in render order", () => {
    const items = buildConversation(turnWithThreeTools())
    expect(foldIdsByKind(items)).toEqual({ turns: ["turn:0"], groups: ["grp:1"] })
  })

  test("checkpoints aren't foldable; a loose tool group is a group", () => {
    const items = buildConversation([
      { kind: "checkpoint", text: "summary" },
      tool("9", "read x"),
      tool("10", "read y"),
    ])
    expect(foldIdsByKind(items)).toEqual({ turns: [], groups: ["grp:9"] })
  })
})

describe("toolGroupSummary / toolGroupState — the collapsed one-line aggregate", () => {
  const t = (name: string, state: ToolPillState, detail?: string): ToolBlock => ({
    kind: "tool",
    id: name,
    toolName: name,
    state,
    ...(detail !== undefined ? { detail } : {}),
  })

  test("names the verbs, counts the calls, rolls up the diffstat", () => {
    const tools = [t("Read(a.ts)", "ok"), t("Grep(parse)", "ok"), t("Edit(a.ts)", "ok", "+5/-2")]
    expect(toolGroupSummary(tools)).toBe("read · grep · edit  (3 tools, +5 -2)")
    expect(toolGroupState(tools)).toBe("ok")
  })

  test("collapses repeated verbs and surfaces running / failed counts", () => {
    const tools = [t("Read(a.ts)", "ok"), t("Read(b.ts)", "running"), t("Bash(x)", "error")]
    expect(toolGroupSummary(tools)).toBe("read ×2 · bash  (3 tools, 1 running, 1 failed)")
    // any error dominates the aggregate state (shows through the fold)
    expect(toolGroupState(tools)).toBe("error")
  })

  test("aggregate state is running when a call is in flight and none errored", () => {
    expect(toolGroupState([t("Read(a)", "ok"), t("Read(b)", "running")])).toBe("running")
  })

  test("a group renders expanded while ANY call runs, settles collapsed when done", () => {
    const live = [t("Read(a)", "ok"), t("Read(b)", "running")]
    expect(toolGroupExpanded("grp:x", live, new Set())).toBe(true) // live feedback
    const done = [t("Read(a)", "ok"), t("Read(b)", "ok")]
    expect(toolGroupExpanded("grp:x", done, new Set())).toBe(false) // settles
    expect(toolGroupExpanded("grp:x", done, new Set(["grp:x"]))).toBe(true) // user-opened
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

describe("the turn head owns the user message (shown exactly once)", () => {
  const summary = "[System note: earlier history handed off]\n\n" + "x".repeat(200)

  test("a long message: full text on the turn, first line as the folded subject — never copied into the body", () => {
    const items = buildConversation([
      { kind: "user", text: summary },
      { kind: "assistant", text: "ok" },
    ])
    const turn = items[0]!
    if (turn.kind !== "turn") throw new Error("expected turn")
    expect(turn.subject).toBe("[System note: earlier history handed off]")
    expect(turn.text).toBe(summary) // expanded head renders this verbatim
    expect(turn.steps).toBe(1) // the assistant block only
    expect(turn.body).toHaveLength(1)
    const first = turn.body[0]!
    if (first.kind !== "block") throw new Error("expected block")
    expect(first.block.kind).toBe("assistant") // no duplicated user block
    // foldId = the turn; folding hides the body, the head shows the subject
    const rows = buildConversationRows(items, new Set(["turn:0"]))
    expect(rows.map((r) => r.key)).toEqual(["turn:0"])
  })

  test("a short single-line prompt: subject === text, body undisturbed", () => {
    const items = buildConversation([
      { kind: "user", text: "do the thing" },
      { kind: "assistant", text: "ok" },
    ])
    const turn = items[0]!
    if (turn.kind !== "turn") throw new Error("expected turn")
    expect(turn.subject).toBe("do the thing")
    expect(turn.text).toBe("do the thing")
    expect(turn.body).toHaveLength(1) // assistant only — no duplicated user block
  })
})

describe("searchConversation — row-granular hits with reveal info", () => {
  const blocks: ScrollbackBlock[] = [
    { kind: "user", text: "fix the parser" }, // turn:0, head matches "parser"
    { kind: "assistant", text: "done" }, // b:1
    { kind: "user", text: "now the lexer" }, // turn:2
    { kind: "assistant", text: "the parser is fine" }, // b:3, inside turn:2
  ]

  test("matches the turn head AND body rows independently, in render order", () => {
    const hits = searchConversation(buildConversation(blocks), "parser")
    expect(hits).toEqual([
      { id: "turn:0" }, // head match — no reveal needed beyond the turn itself
      { id: "b:3", turnId: "turn:2" }, // body match knows its containing turn
    ])
  })

  test("a match inside a tool group hits the group row and carries groupId", () => {
    const items = buildConversation([
      { kind: "user", text: "run checks" },
      { kind: "tool", id: "t1", toolName: "Bash(bun test)", state: "ok", output: "445 pass" },
      { kind: "tool", id: "t2", toolName: "Read(main.ts)", state: "ok", output: "the needle is here" },
    ])
    expect(searchConversation(items, "needle")).toEqual([
      { id: "grp:t1", turnId: "turn:0", groupId: "grp:t1" },
    ])
    // One hit per rendered row: both members match "a", still one group hit.
    expect(searchConversation(items, "a")).toEqual([
      { id: "grp:t1", turnId: "turn:0", groupId: "grp:t1" },
    ])
  })

  test("loose runs and checkpoints match without a turnId; blank query → no hits", () => {
    const items = buildConversation([
      { kind: "info", text: "resumed session" }, // loose, b:0
      { kind: "checkpoint", text: "handoff: parser work" }, // b:1
    ])
    expect(searchConversation(items, "parser")).toEqual([{ id: "b:1" }])
    expect(searchConversation(items, "resumed")).toEqual([{ id: "b:0" }])
    expect(searchConversation(items, "  ")).toEqual([])
  })

  test("matching is case-insensitive", () => {
    const hits = searchConversation(buildConversation(blocks), "PARSER")
    expect(hits.map((h) => h.id)).toEqual(["turn:0", "b:3"])
  })
})

describe("splitByMatch — the word-level highlight segments", () => {
  test("marks every case-insensitive occurrence, plain text between", () => {
    expect(splitByMatch("the Parser parses parsers", "parser")).toEqual([
      { text: "the ", match: false },
      { text: "Parser", match: true }, // original casing preserved
      { text: " parses ", match: false },
      { text: "parser", match: true },
      { text: "s", match: false },
    ])
  })

  test("blank query / no hit / empty text → one unmatched segment", () => {
    expect(splitByMatch("hello", "")).toEqual([{ text: "hello", match: false }])
    expect(splitByMatch("hello", "  ")).toEqual([{ text: "hello", match: false }])
    expect(splitByMatch("hello", "zzz")).toEqual([{ text: "hello", match: false }])
    expect(splitByMatch("", "x")).toEqual([{ text: "", match: false }])
  })

  test("match at the very start / end produces no empty edge segments", () => {
    expect(splitByMatch("apple pie", "apple")).toEqual([
      { text: "apple", match: true },
      { text: " pie", match: false },
    ])
    expect(splitByMatch("eat apple", "apple")).toEqual([
      { text: "eat ", match: false },
      { text: "apple", match: true },
    ])
  })

  test("property: segments always concatenate back to the input verbatim", () => {
    // Full unicode — concatenation identity holds by construction even where
    // case-folding is degenerate ('İ' lowers to 2 units, final-sigma rules…).
    fc.assert(
      fc.property(fc.fullUnicodeString(), fc.fullUnicodeString({ maxLength: 6 }), (text, query) => {
        expect(
          splitByMatch(text, query)
            .map((s) => s.text)
            .join(""),
        ).toBe(text)
      }),
      { numRuns: 200 },
    )
  })

  test("property: on ascii, every matched segment IS the query (case-insensitively)", () => {
    // Matched-segment identity is only sound where lowering is positionally
    // stable — ascii by construction (unicode corners fall back to exact-case).
    const ascii = fc.stringOf(fc.constantFrom(..."abcDEF "), { maxLength: 40 })
    const asciiQ = fc.stringOf(fc.constantFrom(..."abcDEF"), { minLength: 1, maxLength: 4 })
    fc.assert(
      fc.property(ascii, asciiQ, (text, query) => {
        for (const s of splitByMatch(text, query)) {
          if (s.match) expect(s.text.toLowerCase()).toBe(query.toLowerCase())
        }
      }),
      { numRuns: 200 },
    )
  })
})
