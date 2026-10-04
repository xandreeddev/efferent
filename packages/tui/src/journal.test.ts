import { describe, expect, test } from "bun:test"
import { ConversationId } from "@xandreed/core"
import type { SessionLogEvent } from "@xandreed/core"
import { Option } from "effect"
import { createTuiState } from "./state.js"
import { groupActivities } from "./presentation.entity.functions.js"

const session = ConversationId.make("00000000-0000-4000-8000-000000000000")
const inherited = ConversationId.make("11111111-1111-4111-8111-111111111111")
const boot = () => createTuiState({ id: session, workspace: "/workspace/demo", profile: "smith", createdAt: 0 })
const journal = (seq: number, kind: string, data: SessionLogEvent["data"], source = session): SessionLogEvent => ({ session: source, seq, kind, data, at: seq, turn: Option.some(1) })
const started = (source = session) => journal(1, "turn.started", { runId: "native", key: `input:${source}`, origin: "user", userMessage: { text: "build it" }, command: {}, claimed: [], entry: "native:0", at: 0 }, source)
const lifecycle = (seq: number, name: string, data: SessionLogEvent["data"] = {}) => journal(seq, "harness.event", { event: { version: 1, id: String(seq), sessionId: session, seq: seq - 1, at: seq, name, runId: "native", data } })
const assistant = (seq: number, text: string, source = session) => journal(seq, "memory.message", { runId: "native", step: 0, body: { message: { role: "assistant", content: [{ type: "text", text }] } } }, source)
const result = (seq: number, call: string, text: string) => journal(seq, "memory.tool-result", { runId: "native", step: 0, body: { toolCallId: call, toolName: "read_file", isError: false, encoded: { content: text }, view: text, viewVersion: "1", subjects: [], artifacts: [], pinned: false } })

describe("native terminal journal", () => {
  test("early native deltas settle from memory without duplicating the outer reply", () => {
    const state = boot()
    state.deltas([{ name: "native.delta", runId: "native", data: { sourceSession: session, event: { _tag: "assistant.delta", step: 0, channel: "text", id: "text", delta: "streamed" } } }])
    state.journal([started(), lifecycle(2, "run.started")])
    expect(state.transcript().blocks.at(-1)?.text).toBe("streamed")
    expect(state.transcript().blocks.at(-1)?.id).toBe(`${session}:native:0:assistant`)
    state.journal([assistant(3, "settled"), journal(4, "step.usage", { step: 0, model: "fixture:controller", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cacheReadTokens: 0 } }), lifecycle(5, "run.completed", { text: "settled", outcome: "completed" })])
    expect(state.transcript().blocks.filter((block) => block.kind === "assistant").map((block) => [block.text, block.status, block.model])).toEqual([["settled", "complete", "fixture:controller"]])
    expect(state.transcript().tokens).toBe(20)
    expect(state.transcript().totalTokens).toBe(25)
    state.journal([assistant(3, "duplicate")])
    state.delta({ name: "assistant.delta", runId: "native", data: { channel: "text", step: 0, delta: "late" } })
    expect(state.transcript().blocks.at(-1)?.text).toBe("settled")
  })

  test("concurrent tool payloads join their provider ids regardless of completion order", () => {
    const state = boot()
    state.journal([started(),
      journal(2, "tool.started", { step: 0, invocationId: "invocation-a", toolCallId: "call-a", tool: "read_file", input: { path: "a.ts" }, labels: {}, stage: null }),
      journal(3, "tool.started", { step: 0, invocationId: "invocation-b", toolCallId: "call-b", tool: "read_file", input: { path: "b.ts" }, labels: {}, stage: null }),
      journal(4, "tool.completed", { step: 0, invocationId: "invocation-b", toolCallId: "call-b", tool: "read_file", ok: true, durationMs: 20, labels: {}, stage: null }),
      journal(5, "tool.completed", { step: 0, invocationId: "invocation-a", toolCallId: "call-a", tool: "read_file", ok: true, durationMs: 30, labels: {}, stage: null }),
      result(6, "call-a", "contents of a"), result(7, "call-b", "contents of b"),
    ])
    const tools = state.transcript().blocks.filter((block) => block.kind === "tool")
    expect(tools).toHaveLength(2)
    expect(tools.map((block) => [block.text, block.durationMs, block.detail.includes("contents of a"), block.detail.includes("contents of b")])).toEqual([
      ["read_file · a.ts", 30, true, false], ["read_file · b.ts", 20, false, true],
    ])
    expect(groupActivities(tools).map((block) => block.text)).toEqual(["2 read/search calls"])
  })
  test("a rejected call retains its arguments and a later repaired call stays distinct", () => {
    const state = boot()
    const call = (seq: number, step: number, id: string, path: string) => journal(seq, "memory.message", { step, body: { message: { role: "assistant", content: [{ type: "tool-call", toolCallId: id, toolName: "read_file", input: { path } }] } } })
    state.journal([started(), call(2, 0, "missing", "missing.ts"),
      journal(3, "memory.tool-result", { step: 0, body: { toolCallId: "missing", toolName: "read_file", isError: true, encoded: { error: "ReadFailed", message: "missing.ts does not exist" }, view: "full failed result", viewVersion: "1", subjects: [], artifacts: [], pinned: false } }),
      call(4, 1, "fixed", "README.md"),
      journal(5, "tool.started", { step: 1, toolCallId: "fixed", invocationId: "read-2", tool: "read_file", input: { path: "README.md" } }),
      journal(6, "tool.completed", { step: 1, toolCallId: "fixed", invocationId: "read-2", tool: "read_file", ok: true }),
      journal(7, "memory.tool-result", { step: 1, body: { toolCallId: "fixed", toolName: "read_file", isError: false, encoded: "workspace read", view: "workspace read", viewVersion: "1", subjects: [], artifacts: [], pinned: false } }),
    ])
    const tools = state.transcript().blocks.filter((block) => block.kind === "tool")
    expect(tools.map((block) => [block.text, block.status, block.turnIndex])).toEqual([
      ["read_file · missing.ts", "failed", 0], ["read_file · README.md", "complete", 1],
    ])
    expect(tools[0]!.summary).toBe("missing.ts does not exist")
    expect(tools[0]!.detail).toContain('"path": "missing.ts"')
    expect(tools[0]!.detail).toContain("full failed result")
    expect(tools[1]!.detail).toContain("workspace read")
  })

  test("inherited and current seq/step coordinates remain distinct on replay", () => {
    const state = boot()
    state.journal([started(inherited), assistant(2, "parent reply", inherited), started(), assistant(2, "child reply")])
    expect(state.transcript().blocks.filter((block) => block.kind === "assistant").map((block) => block.text)).toEqual(["parent reply", "child reply"])
    expect(new Set(state.transcript().blocks.map((block) => block.id)).size).toBe(4)
    expect(state.transcript().journalPositions).toEqual({ [session]: 2, [inherited]: 2 })
    const replay = boot()
    replay.journal([started(inherited)]); replay.journal([assistant(2, "parent reply", inherited), started()]); replay.journal([assistant(2, "child reply")])
    expect(replay.transcript()).toEqual(state.transcript())
  })

  test("inherited harness counters cannot suppress current lifecycle or streamed text", () => {
    const state = boot()
    const parent = (seq: number, name: string, data: SessionLogEvent["data"] = {}) => journal(seq, "harness.event", { event: { version: 1, id: String(seq), sessionId: inherited, seq: seq + 90, at: seq, name, runId: "native", data } }, inherited)
    state.journal([
      parent(1, "run.started"),
      parent(2, "loop.event", { type: "assistant_message", turnIndex: 0, text: "parent reply" }),
      parent(3, "run.completed", { text: "parent reply" }),
    ])
    expect(state.transcript().seq).toBe(-1)
    expect(state.transcript().status).toBe("Ready")
    state.delta({ name: "assistant.delta", runId: "native", data: { sourceSession: session, channel: "text", turnIndex: 0, delta: "child streaming" } })
    state.journal([lifecycle(1, "run.started")])
    expect(state.transcript().status).toBe("Working")
    expect(state.transcript().blocks.map((block) => block.text)).toEqual(["parent reply", "child streaming"])
    state.journal([
      lifecycle(2, "loop.event", { type: "assistant_message", turnIndex: 0, text: "child reply" }),
      lifecycle(3, "run.completed", { text: "child reply" }),
    ])
    expect(state.transcript().blocks.map((block) => [block.id, block.text])).toEqual([
      [`${inherited}:native:0:assistant`, "parent reply"], [`${session}:native:0:assistant`, "child reply"],
    ])
    expect(state.transcript().status).toBe("Ready")
    expect(state.transcript().seq).toBe(2)
  })

  test("session switches preserve separate dirty drafts and reject an old follower", () => {
    const state = boot()
    state.setComposerText("unfinished main draft")
    state.selectSession({ id: inherited, workspace: "/workspace/demo", profile: "smith", createdAt: 1 })
    expect(state.draft().text).toBe("")
    state.setComposerText("unfinished other draft")
    state.journal([started(), assistant(2, "old callback")], session)
    expect(state.transcript().blocks).toEqual([])
    state.selectSession({ id: session, workspace: "/workspace/demo", profile: "smith", createdAt: 0 })
    expect(state.draft().text).toBe("unfinished main draft")
  })
})
