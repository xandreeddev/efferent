import { test, expect } from "bun:test"
import type { ConversationId } from "@efferent/core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { createTuiStore, type ConvScroller, type TuiContext, type TuiStore } from "../state/store.js"
import { dispatch } from "./dispatch.js"
import type { Key } from "./ParsedKey.js"

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

const key = (name: string, mods: Partial<Key> = {}): Key => ({
  name,
  ctrl: false,
  shift: false,
  meta: false,
  option: false,
  ...mods,
})

interface Harness {
  readonly store: TuiStore
  readonly ctx: TuiContext
  readonly scroll: string[]
  exited: boolean
  copied: number
}

const harness = (): Harness => {
  const store = newStore()
  const scroll: string[] = []
  const scroller: ConvScroller = {
    scrollBy: (n) => scroll.push(`by:${n}`),
    scrollToTop: () => scroll.push("top"),
    scrollToBottom: () => scroll.push("bottom"),
    scrollIntoView: (id) => scroll.push(`into:${id}`),
    viewportRows: () => 20,
  }
  store.convScroller.current = scroller
  const h: Harness = {
    store,
    scroll,
    exited: false,
    copied: 0,
    ctx: {
      store,
      run: () => Promise.resolve(undefined as never),
      submit: () => {},
      interrupt: () => {},
      exit: () => {
        h.exited = true
      },
      copySelection: () => {
        h.copied += 1
        return true
      },
    },
  }
  return h
}

test("conversation pane: j/k scroll a line, Ctrl-D/U a half page (the viewport)", () => {
  const h = harness()
  h.store.setFocus("conversation")
  dispatch(h.ctx, key("j"))
  dispatch(h.ctx, key("k"))
  dispatch(h.ctx, key("d", { ctrl: true }))
  dispatch(h.ctx, key("u", { ctrl: true }))
  expect(h.scroll).toEqual(["by:1", "by:-1", "by:10", "by:-10"])
})

test("conversation pane: {}/[] move the fold cursor, gg/G hit the ends, Tab folds it", () => {
  const h = harness()
  h.store.setFocus("conversation")
  h.store.setBlocks([
    { kind: "user", text: "a" },
    { kind: "assistant", text: "b" },
    { kind: "user", text: "c" },
    { kind: "assistant", text: "d" },
  ])
  // rows: 0 turn:0(head) · 1 b:1 · 2 turn:2(head) · 3 b:3
  dispatch(h.ctx, key("g", { shift: true })) // G → last unit
  expect(h.store.convCursor()).toBe(3)
  dispatch(h.ctx, key("g"))
  dispatch(h.ctx, key("g")) // gg → first unit
  expect(h.store.convCursor()).toBe(0)
  dispatch(h.ctx, key("}")) // paragraph step → next row
  expect(h.store.convCursor()).toBe(1)
  dispatch(h.ctx, key("]")) // message step → next head (turn:2)
  expect(h.store.convCursor()).toBe(2)
  dispatch(h.ctx, key("tab")) // fold the unit under the cursor
  expect([...h.store.collapsed()]).toEqual(["turn:2"])
})

test("conversation pane: Z folds all turns, then unfolds them", () => {
  const h = harness()
  h.store.setFocus("conversation")
  h.store.setBlocks([
    { kind: "user", text: "a" },
    { kind: "assistant", text: "b" },
    { kind: "user", text: "c" },
    { kind: "assistant", text: "d" },
  ])
  dispatch(h.ctx, key("z", { shift: true }))
  expect([...h.store.collapsed()].sort()).toEqual(["turn:0", "turn:2"])
  dispatch(h.ctx, key("z", { shift: true }))
  expect([...h.store.collapsed()]).toEqual([])
})

test("plain z toggles zoom (not fold-all) on a read-only pane", () => {
  const h = harness()
  h.store.setFocus("conversation")
  dispatch(h.ctx, key("z"))
  expect(h.store.zoomed()).toBe(true)
})

test("Ctrl-C arms first, quits on the second press", () => {
  const h = harness()
  dispatch(h.ctx, key("c", { ctrl: true }))
  expect(h.exited).toBe(false)
  expect(h.store.blocks().at(-1)).toMatchObject({ kind: "info" })
  dispatch(h.ctx, key("c", { ctrl: true }))
  expect(h.exited).toBe(true)
})

test("y copies the selection on a read-only pane, not in the input", () => {
  const h = harness()
  h.store.setFocus("conversation")
  dispatch(h.ctx, key("y"))
  expect(h.copied).toBe(1)
  h.store.setFocus("input")
  dispatch(h.ctx, key("y"))
  expect(h.copied).toBe(1) // unchanged — the textarea owns `y` while typing
})

test("Ctrl-h/j/k/l move pane focus and set the mode", () => {
  const h = harness()
  dispatch(h.ctx, key("h", { ctrl: true }))
  expect(h.store.focus()).toBe("conversation")
  expect(h.store.mode()).toBe("normal")
  dispatch(h.ctx, key("j", { ctrl: true }))
  expect(h.store.focus()).toBe("input")
  expect(h.store.mode()).toBe("insert")
})
