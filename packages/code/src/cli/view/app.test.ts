import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import type { AgentMessage, ConversationId } from "@xandreed/sdk-core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { buildContextView } from "../presentation/contextView.js"
import { openSelect } from "../presentation/selectBox.js"
import { openLogin } from "../presentation/loginFlow.js"
import { openSettings } from "../presentation/settingsView.js"
import { makeApp } from "./appHarness.js"
import { createTuiStore, type TuiContext, type TuiStore } from "../state/store.js"
import { makeEventReducer } from "../events/eventPump.js"

const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId

const user = (text: string): AgentMessage => ({ role: "user", content: text })
const assistant = (text: string): AgentMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

const newStore = (): TuiStore =>
  createTuiStore({
    status: {
      modelId: "test-model",
      cwd: "/tmp/ws",
      storage: "sqlite",
    },
    conversationId: cid,
    footer: "logs: …",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1_000_000 } },
  })

const fakeCtx = (store: TuiStore): TuiContext => ({
  store,
  run: () => Promise.resolve(undefined as never),
  submit: () => {},
  interrupt: () => {},
  exit: () => {},
  copySelection: () => false,
  resolveApproval: () => {},
})

test("conversation rail renders a user turn, assistant prose, and a tool pill", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 90,
    height: 28,
  })
  try {
    const reduce = makeEventReducer(store)
    store.pushBlock({ kind: "user", text: "do the thing" })
    reduce({ type: "assistant_message", turnIndex: 0, text: "on it" })
    reduce({
      type: "tool_call_start",
      turnIndex: 0,
      id: "call_a",
      toolName: "read_file",
      args: { path: "a.ts" },
    })
    reduce({
      type: "tool_call_end",
      turnIndex: 0,
      id: "call_a",
      toolName: "read_file",
      ok: true,
      result: { content: "hello" },
    })

    const frame = await waitForFrame(
      (f) => f.includes("do the thing") && f.includes("a.ts"),
    )
    // user turn (plain text) + the rail dot render. NOTE: assistant prose now
    // renders through OpenTUI's native <markdown>, whose child renderables are
    // built lazily and do NOT paint under headless `testRender` (verified live
    // instead). So we assert the structure here, not the prose content ("on it").
    expect(frame).toContain("do the thing")
    expect(frame).toContain("●")
    // status bar shows the model id and the storage label
    expect(frame).toContain("test-model")
    expect(frame).toContain("sqlite")
    // the tool call surfaced its path-derived label
    expect(frame).toContain("a.ts")
  } finally {
    renderer.destroy()
  }
})

test("activity pane shows the execution tree, stats header, and sections", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 110,
    height: 32,
  })
  try {
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({
      type: "tool_call_start",
      turnIndex: 0,
      id: "call_x",
      toolName: "read_file",
      args: { path: "x.ts" },
    })
    reduce({
      type: "assistant_message",
      turnIndex: 0,
      text: "done",
      usage: { inputTokens: 5000, outputTokens: 340, totalTokens: 5340, cacheReadTokens: 0 },
    })
    reduce({ type: "tool_call_end", turnIndex: 0, id: "call_x", toolName: "read_file", ok: true, result: { content: "y" } })
    reduce({ type: "agent_end", finalText: "done", messages: [] })

    const frame = await waitForFrame((f) => f.includes("activity") && f.includes("turn 1"))
    expect(frame).toContain("activity") // side pane title
    expect(frame).toContain("ctx ") // stats gauge label
    expect(frame).toContain("turn 1") // execution-tree turn node
    expect(frame).toContain("1 turn") // stats meta line (turn count)
    expect(frame).toContain("skills") // foldable section
    expect(frame).toContain("instructions") // foldable section
  } finally {
    renderer.destroy()
  }
})

test("typing a `:` command shows the palette autocomplete", async () => {
  const store = newStore()
  const { waitForFrame, mockInput, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 100,
    height: 26,
  })
  try {
    // Focused input receives the keystrokes → onInput → store.input → palette memo.
    await mockInput.pressKeys([":", "c", "l"])
    const frame = await waitForFrame((f) => f.includes(":clear"))
    expect(frame).toContain(":clear") // matched command surfaced
    expect(frame).toContain("Start a new conversation (new id, empty scrollback)") // its description
  } finally {
    renderer.destroy()
  }
})

test("errors surface on the rail", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 90,
    height: 20,
  })
  try {
    const reduce = makeEventReducer(store)
    reduce({ type: "error", message: "boom: provider 500" })
    const frame = await waitForFrame((f) => f.includes("boom: provider 500"))
    expect(frame).toContain("boom: provider 500")
  } finally {
    renderer.destroy()
  }
})

test("a provider 401 renders as a compact, actionable rail block (no token, no flood)", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 90,
    height: 20,
  })
  try {
    // What `submit` now offers to the rail for a revoked-token 401 — the
    // compact `formatFullError` output, NOT the old 75-line inspect dump that
    // flooded the pane and leaked the bearer token.
    const reduce = makeEventReducer(store)
    store.pushBlock({ kind: "user", text: "do the thing" })
    reduce({
      type: "error",
      message:
        "openai request failed (401 token_revoked): Unauthorized - Verify API key.\n" +
        "→ openai credential rejected — run :login to refresh it, or :model to switch provider",
    })

    const frame = await waitForFrame((f) => f.includes(":login"))
    // The actionable hint is visible…
    expect(frame).toContain("401 token_revoked")
    expect(frame).toContain(":login")
    expect(frame).toContain(":model")
    // …the credential never leaks into the UI…
    expect(frame).not.toContain("Bearer")
    expect(frame.toLowerCase()).not.toContain("authorization")
    // …and the error stayed small enough that the prior message is still on screen.
    expect(frame).toContain("do the thing")
  } finally {
    renderer.destroy()
  }
})

test("the side pane switches to the context viewer and renders the turn tree", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 160,
    height: 30,
  })
  try {
    // Build context segments and flip the side pane into the context view —
    // exactly what `toggleContext` does after fetching records.
    const segs = buildContextView([user("fix the parser"), assistant("done")], [])
    store.setProjection((p) => ({ ...p, context: segs }))
    store.setNav((n) => ({ ...n, view: "context", contextCollapsed: new Set(), contextCursor: 0 }))
    store.setFocus("side")

    const frame = await waitForFrame((f) => f.includes("context") && f.includes("fix the parser"))
    expect(frame).toContain("context") // pane title + header
    expect(frame).toContain("loaded context") // the loaded-segment row
    expect(frame).toContain("fix the parser") // a turn subject
    expect(frame).toContain("○") // the unselected pick marker
  } finally {
    renderer.destroy()
  }
})

test("selecting a turn in the context viewer shows the ◉ marker and a count", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 160,
    height: 30,
  })
  try {
    const segs = buildContextView([user("turn one"), assistant("a"), user("turn two"), assistant("b")], [])
    store.setProjection((p) => ({ ...p, context: segs }))
    store.setNav((n) => ({
      ...n,
      view: "context",
      contextCollapsed: new Set(),
      contextSelected: new Set([1]),
      contextCursor: 0,
    }))
    store.setFocus("side")

    const frame = await waitForFrame((f) => f.includes("◉") && f.includes("1 selected"))
    expect(frame).toContain("◉")
    expect(frame).toContain("1 selected")
  } finally {
    renderer.destroy()
  }
})

test("an open select picker renders inline (agy borderless menu) with its options + hints", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 120,
    height: 32,
  })
  try {
    store.setOverlay({
      kind: "select",
      sel: openSelect("Select a model", [
        { value: { id: "g" }, label: "google:gemini-3.5-flash", active: true },
        { value: { id: "o" }, label: "openai:gpt-5.5" },
      ]),
      purpose: { tag: "model" },
    })

    const frame = await waitForFrame((f) => f.includes("Select a model") && f.includes("gpt-5.5"))
    // The picker is now a borderless inline `BottomMenu` in the bottom chrome
    // (not a floating modal): title line, `>`-pointer rows, agy footer — no border,
    // no `i/N` counter.
    expect(frame).toContain("Select a model") // title line
    expect(frame).toContain("google:gemini-3.5-flash")
    expect(frame).toContain("openai:gpt-5.5")
    expect(frame).toContain("◀ active") // the current model tag
    expect(frame).toContain("↑/↓ Navigate") // the agy footer hint
    expect(frame).toContain("Select") // ↵ Select in the footer
  } finally {
    renderer.destroy()
  }
})

test("the :login overlay floats the provider manager with statuses", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 120,
    height: 30,
  })
  try {
    store.setOverlay({
      kind: "login",
      flow: openLogin([
        { provider: "anthropic", configured: "oauth" },
        { provider: "google", configured: "api_key" },
        { provider: "openai", configured: undefined },
        { provider: "opencode", configured: undefined },
        { provider: "ollama", configured: undefined },
      ]),
    })

    const frame = await waitForFrame((f) => f.includes("Sign in to your providers"))
    expect(frame).toContain("Sign in to your providers") // the manager title
    expect(frame).toContain("Anthropic")
    expect(frame).toContain("subscription") // anthropic's status tag (oauth)
    expect(frame).toContain("api key") // google's status tag
  } finally {
    renderer.destroy()
  }
})

test("the :settings overlay floats the settings table with values + hints", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 120,
    height: 30,
  })
  try {
    store.setOverlay({
      kind: "settings",
      state: {
        ...openSettings([
          { key: "allowBash", label: "allowBash", value: "true", kind: "boolean" },
          { key: "maxSteps", label: "maxSteps", value: "20", kind: "number" },
          { key: "model", label: "model", value: "ollama:gemma4", kind: "readonly", hint: "use :model" },
        ]),
        cursor: 2,
      },
    })

    const frame = await waitForFrame((f) => f.includes("Settings") && f.includes("allowBash"))
    expect(frame).toContain("allowBash")
    expect(frame).toContain("maxSteps")
    expect(frame).toContain("use :model") // a readonly row's hint
    expect(frame).toContain("toggle / cycle / edit") // the footer hint
  } finally {
    renderer.destroy()
  }
})
