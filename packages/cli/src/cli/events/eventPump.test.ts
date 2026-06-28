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

describe("eventPump — transient retry notice", () => {
  test("an llm_retry event renders a visible info line (not a silent wait)", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({ type: "llm_retry", reason: "HTTP 429", attempt: 1, maxAttempts: 3, delayMs: 8000 })
    const info = store.blocks().filter((b) => b.kind === "info") as Array<{ text: string }>
    expect(info.length).toBe(1)
    expect(info[0]?.text).toContain("HTTP 429")
    expect(info[0]?.text).toContain("retrying in 8s")
    expect(info[0]?.text).toContain("(attempt 1/3)")
  })
})

describe("eventPump — per-role spend attribution", () => {
  const usage = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cacheReadTokens: 0 }

  test("root usage → general; a code sub-agent's usage → code; the gauge stays root-only", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({ type: "assistant_message", turnIndex: 0, text: "root turn", usage })
    reduce({ type: "subagent_start", name: "worker", task: "t", nodeId: "n1" })
    reduce({
      type: "assistant_message",
      turnIndex: 0,
      text: "inner",
      usage,
      nodeId: "n1",
      subAgentRole: "code",
    })
    const s = store.stats()
    expect(s.byRole.general).toBe(1200)
    expect(s.byRole.code).toBe(1200)
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

  test("an ok end lands the returned summary in the node's log, NEVER on the rail", () => {
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
    // The fleet lives ONLY in the right-pane tree — no `agents` block on the rail.
    expect(store.blocks().some((b) => b.kind === "agents")).toBe(false)
    // The summary streams into the node's own log (its preview shows it).
    const log = [...store.nodeLog("n1")]
    const last = log[log.length - 1]!
    expect(last.kind).toBe("assistant")
    expect((last as { text: string }).text).toBe("Layers respected; two leaks found.")
  })

  test("a failed run lands the error in its node log, NEVER on the rail", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "turn_start", turnIndex: 0 })
    reduce({ type: "subagent_start", name: "cli", task: "t", nodeId: "n1" })
    reduce({ type: "subagent_end", name: "cli", ok: false, summary: "boom", filesChanged: [], nodeId: "n1" })
    // The failure is in the node's own log (its pane shows it), not chat noise.
    expect(logKinds(store, "n1")).toContain("error")
    expect(store.blocks().some((b) => b.kind === "agents")).toBe(false)
  })
})

describe("eventPump — needs_human surfaces a pending-decision roster", () => {
  test("a parked needs_human becomes a decision entry (attribution + reason carried)", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({
      type: "needs_human",
      sessionId: "s1",
      nodeId: "n1",
      tool: "Bash",
      summary: "rm -rf build",
      reason: "destructive command outside the workspace",
      folder: "/work/build",
      parked: true,
    })
    const ds = store.decisions()
    expect(ds).toHaveLength(1)
    expect(ds[0]).toMatchObject({
      sessionId: "s1",
      nodeId: "n1",
      tool: "Bash",
      summary: "rm -rf build",
      reason: "destructive command outside the workspace",
      folder: "/work/build",
      parked: true,
    })
  })

  test("interactive (parked:false) and parked are both surfaced and distinguishable", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "needs_human", sessionId: "s1", summary: "ask A", reason: "r", parked: false })
    reduce({ type: "needs_human", sessionId: "s2", summary: "ask B", reason: "r", parked: true })
    const ds = store.decisions()
    expect(ds).toHaveLength(2)
    expect(ds.find((d) => d.summary === "ask A")!.parked).toBe(false)
    expect(ds.find((d) => d.summary === "ask B")!.parked).toBe(true)
  })

  test("de-dupe: a repeated ask for the same session+summary upserts, doesn't stack", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "needs_human", sessionId: "s1", summary: "ask A", reason: "first", parked: true })
    reduce({ type: "needs_human", sessionId: "s1", summary: "ask A", reason: "second", parked: true })
    const ds = store.decisions()
    expect(ds).toHaveLength(1)
    expect(ds[0]!.reason).toBe("second") // latest wins, in place
  })

  test("the same summary in a DIFFERENT session is a distinct decision", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "needs_human", sessionId: "s1", summary: "same", reason: "r", parked: true })
    reduce({ type: "needs_human", sessionId: "s2", summary: "same", reason: "r", parked: true })
    expect(store.decisions()).toHaveLength(2)
  })

  test("dismiss clears one decision by id", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "needs_human", sessionId: "s1", summary: "ask A", reason: "r", parked: true })
    reduce({ type: "needs_human", sessionId: "s2", summary: "ask B", reason: "r", parked: true })
    const target = store.decisions().find((d) => d.summary === "ask A")!
    store.dismissDecision(target.id)
    const ds = store.decisions()
    expect(ds).toHaveLength(1)
    expect(ds[0]!.summary).toBe("ask B")
  })

  test("approval_resolved auto-clears that session's PARKED decisions, leaves others", () => {
    const store = newStore()
    const reduce = makeEventReducer(store)
    reduce({ type: "needs_human", sessionId: "s1", summary: "parked s1", reason: "r", parked: true })
    reduce({ type: "needs_human", sessionId: "s1", summary: "live s1", reason: "r", parked: false })
    reduce({ type: "needs_human", sessionId: "s2", summary: "parked s2", reason: "r", parked: true })
    reduce({ type: "approval_resolved", sessionId: "s1" })
    const ds = store.decisions()
    // s1's parked entry is gone; s1's interactive entry stays (sheet owns it);
    // s2's parked entry is untouched.
    expect(ds.map((d) => d.summary).sort()).toEqual(["live s1", "parked s2"])
  })
})
