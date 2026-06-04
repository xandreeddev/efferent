import { test, expect } from "bun:test"
import type { ConversationId } from "@efferent/core"
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

test("runSearch matches turns, lands on the last match, focuses + scrolls to it", () => {
  const store = newStore()
  const seen: string[] = []
  store.convScroller.current = fakeScroller(seen)
  seed(store)

  runSearch(store, "parser")
  const s = store.search()
  if (s === undefined) throw new Error("expected an active search")
  // Both turns mention "parser" (turn 0 subject, turn 2 assistant body).
  expect(s.matchIds).toEqual(["turn:0", "turn:2"])
  expect(s.index).toBe(1) // most recent match
  expect(store.focus()).toBe("conversation")
  expect(seen).toEqual(["turn:2"])
})

test("cycleSearch wraps n/N through the matches and scrolls each into view", () => {
  const store = newStore()
  const seen: string[] = []
  store.convScroller.current = fakeScroller(seen)
  seed(store)
  runSearch(store, "parser") // index 1 (turn:2)

  cycleSearch(store, 1) // wrap forward → index 0
  expect(store.search()?.index).toBe(0)
  expect(seen.at(-1)).toBe("turn:0")

  cycleSearch(store, -1) // back → index 1
  expect(store.search()?.index).toBe(1)
  expect(seen.at(-1)).toBe("turn:2")
})

test("runSearch with no hit keeps an empty search so the status line can report it", () => {
  const store = newStore()
  seed(store)
  runSearch(store, "zzz-nope")
  expect(store.search()).toEqual({ query: "zzz-nope", matchIds: [], index: 0 })
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
