import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ConversationId } from "@xandreed/sdk-core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { makeApp } from "./appHarness.js"
import { createTuiStore, type TuiContext, type TuiStore } from "../state/store.js"
import { makeEventReducer } from "../events/eventPump.js"

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
  run: () => Promise.resolve(undefined as never),
  submit: () => {},
  interrupt: () => {},
  exit: () => {},
  copySelection: () => false,
  resolveApproval: () => {},
  roles: [],
  spawnAgent: () => {},
  stopAgent: () => {},
  listFleet: () => [],
  importAgents: () => {},
  getDirective: () => undefined,
  setDirective: () => {},
})

/**
 * Just the **conversation** column of a rendered frame. The layout is two side-
 * by-side boxes (`│<conversation>│ │<activity>│`) split by an empty column, so
 * the activity execution-tree (which ALWAYS lists every tool pill) bleeds into
 * the full-frame string. Slicing to the left of the `│ │` gap lets us assert on
 * the rail's own collapse/expand without the tree's pills as false positives.
 */
const convRegion = (frame: string): string =>
  frame
    .split("\n")
    .map((line) => line.split("│ │")[0] ?? line)
    .join("\n")

/** A 5-added / 2-removed unified diff so `edit_file` reports `+5/-2`. */
const DIFF = [
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,5 @@",
  "+l1",
  "+l2",
  "+l3",
  "+l4",
  "+l5",
  "-old1",
  "-old2",
].join("\n")

/** Drive one turn with two tools (read + edit) so they form a tool group. */
const seedTwoToolTurn = (store: TuiStore): void => {
  const reduce = makeEventReducer(store)
  store.pushBlock({ kind: "user", text: "fix the parser" })
  reduce({ type: "turn_start", turnIndex: 0 })
  reduce({ type: "tool_call_start", turnIndex: 0, id: "c1", toolName: "read_file", args: { path: "a.ts" } })
  reduce({ type: "tool_call_start", turnIndex: 0, id: "c2", toolName: "edit_file", args: { path: "a.ts" } })
  reduce({
    type: "tool_call_end",
    turnIndex: 0,
    id: "c1",
    toolName: "read_file",
    ok: true,
    result: { content: "x", totalLines: 80 },
  })
  reduce({
    type: "tool_call_end",
    turnIndex: 0,
    id: "c2",
    toolName: "edit_file",
    ok: true,
    result: { diff: DIFF, path: "a.ts" },
  })
}

test("a turn's tool run collapses to one summary line (verbs · count · diffstat)", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 90,
    height: 26,
  })
  try {
    seedTwoToolTurn(store)
    const conv = convRegion(await waitForFrame((f) => f.includes("read · edit")))
    // the aggregate summary line, default-collapsed
    expect(conv).toContain("read · edit")
    expect(conv).toContain("(2 tools, +5 -2)")
    // collapsed ⇒ the individual pill labels are NOT painted in the rail
    // (they still show in the activity tree, which `convRegion` strips out)
    expect(conv).not.toContain("Read(a.ts)")
    expect(conv).not.toContain("Edit(a.ts)")
  } finally {
    renderer.destroy()
  }
})

test("expanding the group (group id ∈ collapsed) reveals the individual pills", async () => {
  const store = newStore()
  const { waitForFrame, renderer } = await testRender(makeApp(fakeCtx(store)), {
    width: 90,
    height: 26,
  })
  try {
    seedTwoToolTurn(store)
    await waitForFrame((f) => f.includes("read · edit"))
    // Inverse polarity: a group's id in `collapsed` means EXPANDED. The first
    // top-level pill id is `t1`, so the group id is `grp:t1`.
    store.setCollapsed(new Set(["grp:t1"]))
    // Wait until the RAIL (not the activity tree) paints the pills.
    const conv = convRegion(
      await waitForFrame((f) => convRegion(f).includes("Read(a.ts)") && convRegion(f).includes("Edit(a.ts)")),
    )
    expect(conv).toContain("Read(a.ts)")
    expect(conv).toContain("Edit(a.ts)")
    // the summary header still sits above the expanded pills
    expect(conv).toContain("read · edit")
  } finally {
    renderer.destroy()
  }
})
