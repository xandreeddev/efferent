import { afterEach, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ConversationId } from "@xandreed/sdk-core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { openSelect } from "../presentation/selectBox.js"
import { makeApp } from "./appHarness.js"
import { createTuiStore, type TuiContext, type TuiStore } from "../state/store.js"
import { activeThemeName, setTheme } from "../state/theme.js"
import { overlayKey } from "../keys/overlay.js"
import type { Key } from "../keys/ParsedKey.js"

// The active theme is a process-global signal — reset after each test.
afterEach(() => setTheme("one-dark"))

const key = (name: string): Key => ({
  name,
  ctrl: false,
  shift: false,
  meta: false,
  option: false,
})

const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId
const newStore = (): TuiStore =>
  createTuiStore({
    status: { modelId: "test-model", cwd: "/tmp/ws", storage: "sqlite" },
    conversationId: cid,
    footer: "logs: …",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1_000_000 } },
  })

const fakeCtx = (store: TuiStore): TuiContext => ({
  store,
  variant: "master",
  run: () => Promise.resolve(undefined as never),
  submit: () => {},
  interrupt: () => {},
  newConversation: () => {},
  clearQueue: () => {},
  exit: () => {},
  copySelection: () => false,
  resolveApproval: () => {},
  roles: [],
  tools: [],
  spawnAgent: () => {},
  stopAgent: () => {},
  listFleet: () => [],
  liveAgents: () => [],
  importAgents: () => {},
  importTools: () => {},
})

test("the App paints under tokyo-night (the reactive token proxy survives the native renderer)", async () => {
  // Switch BEFORE mount: the proxy must return real hex strings OpenTUI can parse
  // — a regression guard that the Proxy-backed `tokens` doesn't break colour input.
  setTheme("tokyo-night")
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), { width: 90, height: 24 })
  try {
    store.pushBlock({ kind: "user", text: "hello from tokyo" })
    const frame = await waitForFrame((f) => f.includes("hello from tokyo"))
    expect(frame).toContain("hello from tokyo") // rail painted
    expect(frame).toContain("efferent") // header wordmark painted (no colour-parse throw)
    expect(frame).toContain("test-model")
  } finally {
    renderer.destroy()
  }
})

test("the theme picker live-recolours on highlight move and reverts on Esc", () => {
  setTheme("one-dark")
  const store = newStore()
  const ctx = fakeCtx(store)
  // one-dark is the active (entry) theme; registry order is efferent · one-dark · tokyo-night.
  store.setOverlay({
    kind: "select",
    sel: openSelect("Select a theme", [
      { value: "efferent", label: "efferent" },
      { value: "one-dark", label: "one-dark", active: true },
      { value: "tokyo-night", label: "tokyo-night" },
    ]),
    purpose: { tag: "theme" },
  })

  // Moving the highlight flips the active theme live (preview), not just the list.
  overlayKey(ctx, key("down"))
  expect(activeThemeName()).toBe("tokyo-night")
  overlayKey(ctx, key("up"))
  overlayKey(ctx, key("up"))
  expect(activeThemeName()).toBe("efferent")

  // Esc cancels: the preview reverts to the entry theme (the active-flagged option).
  overlayKey(ctx, key("escape"))
  expect(activeThemeName()).toBe("one-dark")
})

test("the :theme picker overlay floats with both registered themes", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), { width: 90, height: 24 })
  try {
    store.setOverlay({
      kind: "select",
      sel: openSelect("Select a theme", [
        { value: "one-dark", label: "one-dark", active: true },
        { value: "tokyo-night", label: "tokyo-night" },
      ]),
      purpose: { tag: "theme" },
    })
    const frame = await waitForFrame((f) => f.includes("Select a theme") && f.includes("tokyo-night"))
    expect(frame).toContain("Select a theme")
    expect(frame).toContain("one-dark")
    expect(frame).toContain("tokyo-night")
  } finally {
    renderer.destroy()
  }
})
