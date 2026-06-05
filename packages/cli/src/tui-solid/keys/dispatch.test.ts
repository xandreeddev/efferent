import { test, expect } from "bun:test"
import type { ConversationId } from "@efferent/core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { emptyHistory, pushPrompt } from "../presentation/promptHistory.js"
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

// --- input pane (INSERT): command palette + prompt history -------------------

/** Wire an inputControl that mirrors seeded text into the store (like InputBox). */
const wireInput = (h: Harness): { seeds: string[] } => {
  const seeds: string[] = []
  h.store.inputControl.current = {
    seed: (t) => {
      seeds.push(t)
      h.store.setInput(t)
    },
  }
  return { seeds }
}

test("command mode: Enter runs the highlighted command (no Shift needed)", () => {
  const h = harness()
  wireInput(h)
  h.store.pushBlock({ kind: "user", text: "scrollback" })
  h.store.setInput(":clear")
  dispatch(h.ctx, key("return")) // plain Enter
  expect(h.store.blocks()).toEqual([]) // :clear ran (store.clear)
  expect(h.store.input()).toBe("") // buffer cleared
})

test("command mode: Tab completes the buffer to the highlighted command + space", () => {
  const h = harness()
  const { seeds } = wireInput(h)
  h.store.setInput(":mod")
  dispatch(h.ctx, key("tab"))
  expect(seeds.at(-1)).toBe(":model ")
  // → completes too
  h.store.setInput(":mod")
  dispatch(h.ctx, key("right"))
  expect(seeds.at(-1)).toBe(":model ")
})

test("command mode: ↑/↓ move the palette highlight (wrapping)", () => {
  const h = harness()
  wireInput(h)
  h.store.setInput(":s") // matches :settings / :set / :search
  expect(h.store.paletteIndex()).toBe(0)
  dispatch(h.ctx, key("down"))
  expect(h.store.paletteIndex()).toBe(1)
  dispatch(h.ctx, key("up"))
  expect(h.store.paletteIndex()).toBe(0)
  dispatch(h.ctx, key("up")) // wraps to the last visible match
  expect(h.store.paletteIndex()).toBeGreaterThan(0)
})

test("history: ↑/↓ recall sent messages on an empty single-line buffer", () => {
  const h = harness()
  const { seeds } = wireInput(h)
  h.store.setHistory(pushPrompt(pushPrompt(emptyHistory, "first"), "second"))
  h.store.setInput("")
  dispatch(h.ctx, key("up"))
  expect(seeds.at(-1)).toBe("second") // newest first
  dispatch(h.ctx, key("up"))
  expect(seeds.at(-1)).toBe("first")
  dispatch(h.ctx, key("down"))
  expect(seeds.at(-1)).toBe("second")
})

test("history is NOT triggered in command mode (palette owns ↑/↓)", () => {
  const h = harness()
  const { seeds } = wireInput(h)
  h.store.setHistory(pushPrompt(emptyHistory, "a message"))
  h.store.setInput(":") // command mode
  dispatch(h.ctx, key("up"))
  // no history recall seeded; ↑ moved the palette instead
  expect(seeds).not.toContain("a message")
})

test("conversation pane: Tab folds the ENCLOSING turn from a body row", () => {
  const h = harness()
  h.store.setFocus("conversation")
  h.store.setBlocks([
    { kind: "user", text: "do it" },
    { kind: "assistant", text: "sure" },
  ])
  // rows: 0 turn:0(head, foldId) · 1 b:1 (assistant body, no foldId)
  dispatch(h.ctx, key("g", { shift: true })) // G → last row (the body line)
  expect(h.store.convCursor()).toBe(1)
  dispatch(h.ctx, key("tab")) // fold from the body row → folds turn:0
  expect([...h.store.collapsed()]).toEqual(["turn:0"])
  // cursor parked on the (now folded) head
  expect(h.store.convCursor()).toBe(0)
})

test("Ctrl-Shift-C copies the selection (and does NOT arm quit)", () => {
  const h = harness()
  dispatch(h.ctx, key("c", { ctrl: true, shift: true }))
  expect(h.copied).toBe(1) // copied the selection
  expect(h.exited).toBe(false)
  // and it didn't arm the 2x-quit (no "press Ctrl-C again" hint)
  expect(h.store.blocks().some((b) => b.kind === "info")).toBe(false)
})

test("plain Ctrl-C still arms quit (shift excluded)", () => {
  const h = harness()
  dispatch(h.ctx, key("c", { ctrl: true }))
  expect(h.copied).toBe(0)
  expect(h.store.blocks().at(-1)).toMatchObject({ kind: "info" })
})
