import { test, expect } from "bun:test"
import { Effect } from "effect"
import type { ConversationId } from "@xandreed/sdk-core"
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
      resolveApproval: () => {},
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
  // the arm hint is a toast (status note), never a rail block
  expect(h.store.note()).toContain("again to quit")
  expect(h.store.blocks().some((b) => b.kind === "info")).toBe(false)
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
  const before = h.store.run.getConversationId()
  h.store.setInput(":clear")
  dispatch(h.ctx, key("return")) // plain Enter
  expect(h.store.run.getConversationId()).not.toBe(before) // :clear starts a new conversation
  expect(h.store.blocks()).toHaveLength(1) // info line for the new conversation
  expect(h.store.blocks()[0]).toMatchObject({ kind: "info", text: expect.stringMatching(/^new conversation: /) })
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

test("↑ on an empty composer pulls the most-recent queued message back to edit", () => {
  const h = harness()
  const { seeds } = wireInput(h)
  h.store.setHistory(pushPrompt(emptyHistory, "old message"))
  h.store.run.enqueue("queued one")
  h.store.run.enqueue("queued two")
  h.store.setInput("")
  dispatch(h.ctx, key("up"))
  expect(seeds.at(-1)).toBe("queued two") // most-recent queued, NOT history recall
  expect(h.store.queued()).toEqual(["queued one"]) // it left the queue
})

test("? on an empty composer opens the shortcuts overlay", () => {
  const h = harness()
  wireInput(h)
  h.store.setInput("")
  dispatch(h.ctx, key("?"))
  expect(h.store.overlay().kind).toBe("shortcuts")
})

test("? in a read-only pane opens the shortcuts overlay", () => {
  const h = harness()
  h.store.setFocus("conversation")
  dispatch(h.ctx, key("?"))
  expect(h.store.overlay().kind).toBe("shortcuts")
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

test("v on the side pane cycles sessions→activity: preventDefault'd, focus never moves", async () => {
  // The original bug: `v` from the last view routed through a toggle whose
  // close branch refocused the input — the keypress then fell through to the
  // textarea as a literal "v". The cycle must stay on the side pane.
  // (sessions→stack is the cycle's only service-free branch, so the test can
  // run the dispatched effect for real.)
  const h = harness()
  h.store.setFocus("side")
  h.store.setMode("normal")
  h.store.setNav((n) => ({ ...n, view: "sessions" }))
  let prevented = 0
  const ran: Array<Promise<unknown>> = []
  const ctx: TuiContext = {
    ...h.ctx,
    // Run the dispatched effect for real — the tree→stack branch is pure.
    run: (eff) => {
      const p = Effect.runPromise(eff as Effect.Effect<never>)
      ran.push(p)
      return p
    },
  }
  dispatch(ctx, { ...key("v"), preventDefault: () => void (prevented += 1) })
  await Promise.all(ran)
  expect(prevented).toBe(1)
  expect(ran.length).toBe(1)
  expect(h.store.sidePane().view).toBe("stack")
  expect(h.store.focus()).toBe("side")
  expect(h.store.mode()).toBe("normal")
  expect(h.store.input()).toBe("") // no stray character reached the buffer
})

// --- node-session preview (the :tree Enter overlay) --------------------------

const openPreview = (h: Harness): void => {
  h.store.setCollapsed(new Set(["turn:0"]))
  h.store.setNodePreview({
    nodeId: "node-1",
    title: "agent: adapters",
    blocks: [{ kind: "info", text: "agent adapters · spawned · seed: task" }],
    savedCollapsed: h.store.collapsed(),
  })
  h.store.setCollapsed(new Set())
  h.store.setFocus("conversation")
  h.store.setMode("normal")
}

test("q closes the preview: overlay dropped, folds restored, focus back to side", () => {
  const h = harness()
  h.store.setBlocks([{ kind: "user", text: "live rail" }])
  openPreview(h)
  expect(h.store.viewBlocks().map((b) => b.kind)).toEqual(["info"]) // overlay shows
  dispatch(h.ctx, key("q"))
  expect(h.store.nodePreview()).toBeUndefined()
  expect(h.store.viewBlocks().map((b) => b.kind)).toEqual(["user"]) // live rail back
  expect([...h.store.collapsed()]).toEqual(["turn:0"]) // folds restored
  expect(h.store.focus()).toBe("side")
  expect(h.scroll.at(-1)).toBe("bottom")
})

test("Esc (idle, no search) closes the preview; Esc while busy interrupts and keeps it", () => {
  const h = harness()
  let interrupted = 0
  const ctx: TuiContext = { ...h.ctx, interrupt: () => void (interrupted += 1) }
  openPreview(h)
  h.store.setBusy(true)
  dispatch(ctx, key("escape"))
  expect(interrupted).toBe(1)
  expect(h.store.nodePreview()).toBeDefined() // busy Esc = interrupt only
  h.store.setBusy(false)
  dispatch(ctx, key("escape"))
  expect(h.store.nodePreview()).toBeUndefined()
})

test("an active conversation search makes Esc clear the search before the preview", () => {
  const h = harness()
  openPreview(h)
  h.store.setSearch({ query: "x", pane: "conversation", matchIds: [], index: 0 })
  dispatch(h.ctx, key("escape"))
  expect(h.store.search()).toBeUndefined() // search cleared…
  expect(h.store.nodePreview()).toBeDefined() // …preview still open
  dispatch(h.ctx, key("escape"))
  expect(h.store.nodePreview()).toBeUndefined()
})

test("plain Ctrl-C still arms quit (shift excluded)", () => {
  const h = harness()
  dispatch(h.ctx, key("c", { ctrl: true }))
  expect(h.copied).toBe(0)
  expect(h.store.note()).toContain("again to quit")
})
