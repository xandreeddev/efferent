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
