import { test, expect } from "bun:test"
import type { ConversationId } from "@xandreed/sdk-core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { createTuiStore, type ConvScroller, type TuiStore } from "../state/store.js"
import { clearSearch, cycleSearch, runSearch } from "./search.js"

const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId

const newStore = (): TuiStore =>
  createTuiStore({
    status: {
      modelId: "m",
      cwd: "/work",
      storage: "sqlite",
    },
    conversationId: cid,
    footer: "f",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1000 } },
  })

const fakeScroller = (seen: string[]): ConvScroller => ({
  scrollBy: () => {},
  scrollToTop: () => {},
  scrollToBottom: () => {},
  scrollIntoView: (id) => seen.push(id),
  viewportRows: () => 20,
})

const seed = (store: TuiStore): void =>
  store.setBlocks([
    { kind: "user", text: "fix the parser" },
    { kind: "assistant", text: "done" },
    { kind: "user", text: "now the lexer" },
    { kind: "assistant", text: "the parser is fine" },
  ])

test("runSearch matches rows (turn head + body), lands on the last match, focuses + scrolls to it", () => {
  const store = newStore()
  const seen: string[] = []
  store.convScroller.current = fakeScroller(seen)
  seed(store)

  runSearch(store, "parser")
  const s = store.search()
  if (s === undefined) throw new Error("expected an active search")
  // Row-granular: turn 0's HEAD mentions "parser"; turn 2 matches via its
  // assistant body row (b:3), not the whole turn.
  expect(s.matchIds).toEqual(["turn:0", "b:3"])
  expect(s.index).toBe(1) // most recent match
  expect(store.focus()).toBe("chat")
  expect(seen).toEqual(["b:3"])
})

test("cycleSearch wraps n/N through the matches and scrolls each into view", () => {
  const store = newStore()
  const seen: string[] = []
  store.convScroller.current = fakeScroller(seen)
  seed(store)
  runSearch(store, "parser") // index 1 (b:3)

  cycleSearch(store, 1) // wrap forward → index 0
  expect(store.search()?.index).toBe(0)
  expect(seen.at(-1)).toBe("turn:0")

  cycleSearch(store, -1) // back → index 1
  expect(store.search()?.index).toBe(1)
  expect(seen.at(-1)).toBe("b:3")
})

test("jumping to a match inside a FOLDED turn unfolds it (and parks the cursor on the row)", () => {
  const store = newStore()
  const seen: string[] = []
  store.convScroller.current = fakeScroller(seen)
  seed(store)
  // Both turns folded — the post-send compact state.
  store.setCollapsed(new Set(["turn:0", "turn:2"]))

  runSearch(store, "parser") // lands on b:3, hidden inside folded turn:2
  expect(store.collapsed().has("turn:2")).toBe(false) // revealed
  expect(store.collapsed().has("turn:0")).toBe(true) // untouched (its hit is the head)
  expect(seen.at(-1)).toBe("b:3")
  // The fold cursor sits on the revealed row: turn:0(head) → turn:2(head) → b:3.
  expect(store.convCursor()).toBe(2)

  cycleSearch(store, 1) // → turn:0's head; a head hit needs no unfold
  expect(store.collapsed().has("turn:0")).toBe(true)
})

test("a match in a tool lands on that tool's own row (tools render expanded, no group)", () => {
  const store = newStore()
  const seen: string[] = []
  store.convScroller.current = fakeScroller(seen)
  store.setBlocks([
    { kind: "user", text: "run checks" },
    { kind: "tool", id: "t1", toolName: "Bash(bun test)", state: "ok", output: "445 pass" },
    { kind: "tool", id: "t2", toolName: "Read(main.ts)", state: "ok", output: "the needle is here" },
  ])

  runSearch(store, "needle")
  // No tool group to expand — the hit is the tool's own (already-expanded) row.
  expect(store.search()?.matchIds).toEqual(["t2"])
  expect(seen.at(-1)).toBe("t2")
})

test("runSearch with no hit keeps an empty search so the status line can report it", () => {
  const store = newStore()
  seed(store)
  runSearch(store, "zzz-nope")
  expect(store.search()).toEqual({
    query: "zzz-nope",
    pane: "conversation",
    matchIds: [],
    index: 0,
    hits: [],
  })
})

test("runSearch on the fleet tree matches a workspace session row and moves the tree cursor", () => {
  const store = newStore()
  store.setSearchPane("side") // the tree maps to the "side" search pane
  store.setNav((n) => ({ ...n, view: "tree" }))
  // The fleet tree lists every workspace session as a root (the active one
  // marked) — search matches a session row by its label.
  store.setProjection((p) => ({
    ...p,
    sessions: [
      { id: "a", label: "edit lexer.ts", active: true },
      { id: "b", label: "edit parser.ts", active: false },
    ],
  }))
  runSearch(store, "parser")
  const s = store.search()
  if (s === undefined) throw new Error("expected a fleet-tree search")
  expect(s.pane).toBe("side")
  expect(s.matchIds).toEqual(["1"]) // row index 1 — the "edit parser.ts" session
  expect(store.focus()).toBe("tree")
  expect(store.nav().treeCursor).toBe(1) // cursor jumped to the match
})

test("clearSearch drops the search; clear() also drops it", () => {
  const store = newStore()
  seed(store)
  runSearch(store, "parser")
  clearSearch(store)
  expect(store.search()).toBeUndefined()

  runSearch(store, "parser")
  store.clear()
  expect(store.search()).toBeUndefined()
})
