import { describe, expect, test } from "bun:test"
import { ConversationId } from "@xandreed/core"
import type { SessionEvent, SessionRecord } from "@xandreed/core"
import { createTuiState } from "./state.js"

const record = (id = "00000000-0000-4000-8000-000000000000"): SessionRecord => ({ id: ConversationId.make(id), workspace: "/workspace/demo", profile: "smith", createdAt: 0 })
const durable = (seq: number, name: string, runId = "run", data: SessionEvent["data"] = {}, session = record()): SessionEvent => ({ version: 1, id: `${runId}:${seq}`, sessionId: session.id, seq, at: seq, name, runId, data })
const delta = (text: string, runId = "run") => ({ name: "assistant.delta", runId, data: { channel: "text", turnIndex: 0, delta: text } })

describe("terminal stream ordering", () => {
  test("one durable batch replays early deltas before its authoritative settlement", () => {
    const state = createTuiState(record())
    state.deltas([delta("early "), delta("response")])
    state.events([
      durable(0, "run.started"),
      durable(1, "loop.event", "run", { type: "assistant_message", turnIndex: 0, text: "final response" }),
      durable(2, "run.completed", "run", { text: "final response", outcome: "completed" }),
    ])
    expect(state.transcript().blocks.map((block) => [block.text, block.status])).toEqual([["final response", "complete"]])
    state.delta(delta(" late"))
    expect(state.transcript().blocks.map((block) => block.text)).toEqual(["final response"])
    expect(state.transcript().status).toBe("Ready")
  })

  test("settlement without an observed start drops buffered and later text", () => {
    const state = createTuiState(record())
    state.delta(delta("never display"))
    state.event(durable(0, "run.cancelled"))
    state.delta(delta("also late"))
    state.event(durable(1, "run.started", "later"))
    state.delta(delta("visible", "later"))
    expect(state.transcript().blocks.map((block) => block.text)).toEqual(["Cancelled", "visible"])
  })

  test("a new run preserves only its own early deltas and ignores the previous run", () => {
    const state = createTuiState(record())
    state.event(durable(0, "run.started"))
    state.delta(delta("first"))
    state.delta(delta("next", "next"))
    state.event(durable(1, "run.completed", "run", { text: "first" }))
    state.event(durable(2, "run.started", "next"))
    state.delta(delta("stale"))
    expect(state.transcript().blocks.map((block) => block.text)).toEqual(["first", "next"])
  })

  test("session switching clears early text and rejects previous-session callbacks", () => {
    const previous = record()
    const selected = record("11111111-1111-4111-8111-111111111111")
    const state = createTuiState(previous)
    state.delta(delta("old buffered"), previous.id)
    state.selectSession(selected)
    state.delta(delta("old callback"), previous.id)
    state.events([durable(0, "run.started", "run", {}, previous)])
    expect(state.transcript().seq).toBe(-1)
    state.event(durable(0, "run.started", "run", {}, selected))
    expect(state.transcript().blocks).toEqual([])
    state.delta(delta("selected"), selected.id)
    expect(state.transcript().blocks.map((block) => block.text)).toEqual(["selected"])
  })

  test("early deltas of a later turn replay after the earlier turns in the same durable batch", () => {
    const state = createTuiState(record())
    state.deltas([{ name: "assistant.delta", runId: "run", data: { channel: "text", turnIndex: 1, delta: "streaming turn one" } }])
    state.events([
      durable(0, "input.queued", "run", { id: "input", text: "question" }),
      durable(1, "run.started"),
      durable(2, "loop.event", "run", { type: "assistant_message", turnIndex: 0, text: "turn zero" }),
      durable(3, "loop.event", "run", { type: "tool_start", turnIndex: 0, toolCallId: "call", toolName: "read", args: {} }),
    ])
    expect(state.transcript().blocks.map((block) => [block.id, block.text])).toEqual([
      ["input", "question"], ["run:0:assistant", "turn zero"], ["run:tool:call:0", "read"], ["run:1:assistant", "streaming turn one"],
    ])
  })

  test("future-run buffering retains at most the newest 128 deltas in order", () => {
    const state = createTuiState(record())
    state.deltas(Array.from({ length: 200 }, (_, index) => delta(`${index},`)))
    state.event(durable(0, "run.started"))
    expect(state.transcript().blocks.map((block) => block.text)).toEqual([Array.from({ length: 128 }, (_, index) => `${index + 72},`).join("")])
  })

  test.each([true, false])("earlier turns arriving across durable batches precede streaming text (early=%s)", (early) => {
    const state = createTuiState(record())
    const later = { name: "assistant.delta", runId: "run", data: { channel: "text", turnIndex: 1, delta: "streaming turn one" } }
    if (early) state.delta(later)
    state.events([durable(0, "input.queued", "run", { id: "input", text: "question" }), durable(1, "run.started")])
    if (!early) state.delta(later)
    state.events([durable(2, "loop.event", "run", { type: "assistant_message", turnIndex: 0, text: "turn zero" })])
    state.events([durable(3, "loop.event", "run", { type: "tool_start", turnIndex: 0, toolCallId: "call", toolName: "read", args: {} })])
    expect(state.transcript().blocks.map((block) => block.id)).toEqual(["input", "run:0:assistant", "run:tool:call:0", "run:1:assistant"])
    state.events([durable(4, "loop.event", "run", { type: "assistant_message", turnIndex: 1, text: "final turn one" })])
    expect(state.transcript().blocks.map((block) => block.text)).toEqual(["question", "turn zero", "read", "final turn one"])
  })

  test("assistant text arriving after its tools keeps tool order and earlier runs intact", () => {
    const state = createTuiState(record())
    state.events([durable(0, "run.started", "previous"), durable(1, "run.completed", "previous", { text: "previous reply" }), durable(2, "run.started")])
    state.events([durable(3, "loop.event", "run", { type: "tool_start", turnIndex: 0, toolCallId: "a", toolName: "first", args: {} }), durable(4, "loop.event", "run", { type: "tool_start", turnIndex: 0, toolCallId: "b", toolName: "second", args: {} })])
    state.delta(delta("assistant"))
    expect(state.transcript().blocks.map((block) => block.text)).toEqual(["previous reply", "assistant", "first", "second"])
  })

  test("run ids containing tool separators keep earlier run blocks intact", () => {
    const state = createTuiState(record())
    state.events([
      durable(0, "run.started", "run:tool"),
      durable(1, "loop.event", "run:tool", { type: "assistant_message", turnIndex: 3, text: "previous assistant" }),
      durable(2, "loop.event", "run:tool", { type: "tool_end", turnIndex: 3, toolCallId: "previous", toolName: "previous tool", result: {} }),
      durable(3, "run.completed", "run:tool", { text: "previous reply" }),
      durable(4, "run.started", "run"),
    ])
    state.delta(delta("current assistant"))
    expect(state.transcript().blocks.map((block) => block.text)).toEqual(["previous assistant", "previous tool", "previous reply", "current assistant"])
  })
})
