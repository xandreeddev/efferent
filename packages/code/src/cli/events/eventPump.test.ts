import { describe, expect, test } from "bun:test"
import type { ConversationId } from "@xandreed/sdk-core"
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

describe("eventPump — per-role spend attribution", () => {
  const usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 0 }

  test("root AND sub-agent usage land on MAIN (delegation isn't a tier change); the gauge stays root-only", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({ type: "assistant_message", turnIndex: 0, text: "root turn", usage })
    reduce({ type: "subagent_start", name: "worker", task: "t", nodeId: "n1" })
    reduce({ type: "assistant_message", turnIndex: 0, text: "inner", usage, nodeId: "n1" })
    const s = store.stats()
    expect(s.byRole.main).toBe(2400)
    expect(s.byRole.fast).toBe(0)
    // The context gauge reflects the ROOT conversation only.
    expect(s.inputTokens).toBe(1000)
    expect(s.turns).toBe(1)
  })
})

describe("eventPump — the plan mirrors the top-level agent's update_plan calls", () => {
  const steps = [
    { step: "read the code", status: "done" },
    { step: "fix the bug", status: "active" },
    { step: "run tests", status: "pending" },
  ]

  test("a top-level update_plan call replaces the session plan", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({ type: "tool_call_start", turnIndex: 0, id: "p1", toolName: "update_plan", args: { steps } })
    expect(store.projection().plan.map((s) => s.status)).toEqual(["done", "active", "pending"])
  })

  test("a sub-agent's plan stays node-local (never the session plan)", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({ type: "subagent_start", name: "x", task: "t", nodeId: "n1" })
    reduce({ type: "tool_call_start", turnIndex: 0, id: "p1", toolName: "update_plan", args: { steps }, nodeId: "n1" })
    expect(store.projection().plan).toEqual([])
  })

  test("malformed args leave the plan untouched", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "tool_call_start", turnIndex: 0, id: "p1", toolName: "update_plan", args: { steps: [{ nope: 1 }] } })
    expect(store.projection().plan).toEqual([])
  })
})

describe("eventPump — a node's live log accumulates from the start (open any time, see it all)", () => {
  const logKinds = (store: TuiStore, id: string): string[] =>
    [...store.nodeLog(id)].map((b) => b.kind)

  test("events accumulate in the node's log whether or not its pane is open", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    // Spawn with NO pane open — the log STILL captures the task + the tool, so a
    // later open shows the whole run (this is what fixed "I lose state on swap").
    reduce({ type: "subagent_start", name: "cli", task: "do it", nodeId: "n1" })
    reduce({ type: "tool_call_start", turnIndex: 0, id: "a", toolName: "ls", args: {}, nodeId: "n1" })
    expect(logKinds(store, "n1")).toEqual(["user", "tool"]) // task + tool, no pane
    // Open the pane later; more events keep landing in the same log.
    store.setNodePreview({ nodeId: "n1", title: "agent: cli", blocks: [], savedCollapsed: new Set() })
    reduce({ type: "tool_call_start", turnIndex: 0, id: "b", toolName: "read_file", args: { path: "p" }, nodeId: "n1" })
    reduce({ type: "assistant_message", turnIndex: 0, text: "done", nodeId: "n1" })
    expect(logKinds(store, "n1")).toEqual(["user", "tool", "tool", "assistant"])
    // Ends keep pairing: the second tool pill resolves in place.
    reduce({ type: "tool_call_end", turnIndex: 0, id: "b", toolName: "read_file", ok: true, result: {}, nodeId: "n1" })
    const pills = [...store.nodeLog("n1")].filter((b) => b.kind === "tool") as Array<{ state: string }>
    expect(pills[1]!.state).toBe("ok")
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

  test("a failed run lands the error in its node log AND closes the grouped-block row", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({ type: "subagent_start", name: "cli", task: "t", nodeId: "n1" }) // agents block row
    reduce({ type: "subagent_end", name: "cli", ok: false, summary: "boom", filesChanged: [], nodeId: "n1" })
    // The failure is in the node's own log (its pane shows it) regardless of
    // whether the pane is open, AND the grouped row closes as error.
    expect(logKinds(store, "n1")).toContain("error")
    const agents = store.blocks().find((b) => b.kind === "agents") as { agents: ReadonlyArray<{ status: string }> }
    expect(agents.agents[0]!.status).toBe("error")
  })
})
