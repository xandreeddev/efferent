import { test, expect } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ConversationId } from "@xandreed/sdk-core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { makeApp } from "./appHarness.js"
import { createTuiStore, type TuiContext, type TuiStore } from "../state/store.js"
import { makeEventReducer } from "../events/eventPump.js"

/**
 * UI INVARIANTS — deterministic regression guards (Phase 3 of the eval plan).
 * Each pumps a synthetic `AgentEvent` sequence through the real reducer + a
 * headless `testRender`, and asserts the rendered frame. These pin the exact
 * UI regressions hit during the routing/plan/read/loader work, so a future
 * change that re-breaks them fails in CI instead of in the user's terminal.
 * (Native <markdown>/<diff> don't paint headless — assert structure, per the
 * convention in app.test.ts.)
 */

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
  getDirective: () => undefined,
  setDirective: () => {},
})

test("read_file renders as the pill + line count, NOT a content body dump", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 100,
    height: 24,
  })
  try {
    const reduce = makeEventReducer(store)
    reduce({ type: "tool_call_start", turnIndex: 0, id: "r1", toolName: "read_file", args: { path: "config.ts" } })
    reduce({
      type: "tool_call_end",
      turnIndex: 0,
      id: "r1",
      toolName: "read_file",
      ok: true,
      result: { content: "SECRET_BODY_LINE_ONE\nSECRET_BODY_LINE_TWO\nSECRET_BODY_LINE_THREE", totalLines: 42 },
    })
    const frame = await waitForFrame((f) => f.includes("config.ts"))
    // The pill + its `N lines` summary show…
    expect(frame).toContain("config.ts")
    expect(frame).toContain("42 lines")
    // …but the file BODY is never dumped into the rail (the regression).
    expect(frame).not.toContain("SECRET_BODY_LINE_ONE")
  } finally {
    renderer.destroy()
  }
})

test("a running sub-agent does NOT light the root loader as 'thinking'", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 100,
    height: 24,
  })
  try {
    const reduce = makeEventReducer(store)
    // A sub-agent starts while the ROOT is idle (no turn_start). The root loader
    // tracks root phase only — the fleet's activity belongs on the right pane.
    reduce({ type: "subagent_start", name: "code worker", task: "implement the feature", nodeId: "n1", role: "code" })
    const frame = await waitForFrame((f) => f.length > 0)
    // The bottom running-loader's phase word must NOT appear from a sub-agent alone.
    expect(frame).not.toContain("thinking")
  } finally {
    renderer.destroy()
  }
})

test("an edit_file diff and a failed tool both surface on the rail", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 100,
    height: 24,
  })
  try {
    const reduce = makeEventReducer(store)
    reduce({ type: "tool_call_start", turnIndex: 0, id: "e1", toolName: "edit_file", args: { path: "math.ts" } })
    reduce({
      type: "tool_call_end",
      turnIndex: 0,
      id: "e1",
      toolName: "edit_file",
      ok: true,
      result: { path: "math.ts", diff: "--- a/math.ts\n+++ b/math.ts\n@@ -1 +1 @@\n-old\n+new\n" },
    })
    reduce({ type: "tool_call_start", turnIndex: 0, id: "b1", toolName: "Bash", args: { command: "bun x" } })
    reduce({
      type: "tool_call_end",
      turnIndex: 0,
      id: "b1",
      toolName: "Bash",
      ok: false,
      result: { error: "CommandFailed", message: "boom" },
    })
    const frame = await waitForFrame((f) => f.includes("math.ts"))
    expect(frame).toContain("math.ts") // the edit pill
    expect(frame).toContain("+1/-1") // its diffstat summary
    expect(frame).toContain("boom") // the failed bash surfaced
  } finally {
    renderer.destroy()
  }
})
