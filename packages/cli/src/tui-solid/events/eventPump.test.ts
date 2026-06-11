import { describe, expect, test } from "bun:test"
import type { ConversationId } from "@efferent/core"
import { emptySidePane, emptyStats } from "../presentation/sidePane.js"
import { createTuiStore, type TuiStore } from "../state/store.js"
import { makeEventReducer } from "./eventPump.js"

const cid = "00000000-0000-0000-0000-000000000000" as unknown as ConversationId

const newStore = (): TuiStore =>
  createTuiStore({
    status: { modelId: "m", cwd: "/work", storage: "sqlite" },
    conversationId: cid,
    footer: "f",
    sidePane: { ...emptySidePane, stats: { ...emptyStats, contextWindow: 1000 } },
  })

const toolStates = (store: TuiStore): string[] =>
  store
    .blocks()
    .filter((b) => b.kind === "tool")
    .map((b) => (b as { state: string }).state)

describe("eventPump — tool start/end matching (FIFO per call id)", () => {
  test("two same-named calls in one turn both resolve (no stuck 'running')", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    // The loop emits all starts, then all ends — two read_file calls share a name
    // but carry distinct ids. Before the fix the second start overwrote the first
    // and one pill was stranded "running".
    reduce({ type: "tool_call_start", turnIndex: 0, id: "c1", toolName: "read_file", args: { path: "a.ts" } })
    reduce({ type: "tool_call_start", turnIndex: 0, id: "c2", toolName: "read_file", args: { path: "b.ts" } })
    reduce({ type: "tool_call_end", turnIndex: 0, id: "c1", toolName: "read_file", ok: true, result: { content: "x" } })
    reduce({ type: "tool_call_end", turnIndex: 0, id: "c2", toolName: "read_file", ok: false, result: { error: "no" } })
    // First pill resolved from c1 (ok), second from c2 (error) — both terminal.
    expect(toolStates(store)).toEqual(["ok", "error"])
  })

  test("falls back to FIFO-by-name when the provider omits ids", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "tool_call_start", turnIndex: 0, id: "", toolName: "grep", args: {} })
    reduce({ type: "tool_call_start", turnIndex: 0, id: "", toolName: "grep", args: {} })
    reduce({ type: "tool_call_end", turnIndex: 0, id: "", toolName: "grep", ok: true, result: {} })
    reduce({ type: "tool_call_end", turnIndex: 0, id: "", toolName: "grep", ok: true, result: {} })
    expect(toolStates(store)).toEqual(["ok", "ok"])
  })
})

describe("eventPump — preview streaming is read live, not captured at spawn", () => {
  const previewBlocks = (store: TuiStore): string[] =>
    (store.nodePreview()?.blocks ?? []).map((b) => b.kind)

  test("a preview opened MID-RUN starts receiving the node's events", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    // Spawn with NO preview open — the old captured flag stayed unset forever.
    reduce({ type: "subagent_start", name: "cli", task: "t", nodeId: "n1" })
    reduce({ type: "tool_call_start", turnIndex: 0, id: "a", toolName: "ls", args: {}, nodeId: "n1" })
    expect(previewBlocks(store)).toEqual([]) // nothing open yet
    // The human opens the node's session while it runs.
    store.setNodePreview({ nodeId: "n1", title: "agent: cli", blocks: [], savedCollapsed: new Set() })
    reduce({ type: "tool_call_start", turnIndex: 0, id: "b", toolName: "read_file", args: { path: "p" }, nodeId: "n1" })
    reduce({ type: "assistant_message", turnIndex: 0, text: "done", nodeId: "n1" })
    expect(previewBlocks(store)).toEqual(["tool", "assistant"])
    // Ends keep pairing: the pill opened in the preview resolves there.
    reduce({ type: "tool_call_end", turnIndex: 0, id: "b", toolName: "read_file", ok: true, result: {}, nodeId: "n1" })
    const pill = store.nodePreview()!.blocks.find((b) => b.kind === "tool") as { state: string }
    expect(pill.state).toBe("ok")
  })

  test("an ok end lands the returned summary on the agents-block row", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({ type: "subagent_start", name: "tui", task: "audit", nodeId: "n1" })
    reduce({
      type: "subagent_end",
      name: "tui",
      ok: true,
      summary: "Layers respected; two leaks found.",
      filesChanged: [],
      nodeId: "n1",
    })
    const agents = store.blocks().find((b) => b.kind === "agents") as {
      agents: ReadonlyArray<{ status: string; summary?: string }>
    }
    expect(agents.agents[0]!.status).toBe("ok")
    expect(agents.agents[0]!.summary).toBe("Layers respected; two leaks found.")
  })

  test("a watched node that ALSO has a grouped-block row gets both closed on end", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({ type: "subagent_start", name: "cli", task: "t", nodeId: "n1" }) // unwatched → agents block row
    store.setNodePreview({ nodeId: "n1", title: "agent: cli", blocks: [], savedCollapsed: new Set() })
    reduce({ type: "subagent_end", name: "cli", ok: false, summary: "boom", filesChanged: [], nodeId: "n1" })
    // The failure lands in the preview AND the grouped row closes as error.
    expect(previewBlocks(store)).toContain("error")
    const agents = store.blocks().find((b) => b.kind === "agents") as { agents: ReadonlyArray<{ status: string }> }
    expect(agents.agents[0]!.status).toBe("error")
  })
})
