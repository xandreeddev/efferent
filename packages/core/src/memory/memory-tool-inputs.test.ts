import { expect, test } from "bun:test"
import { InvocationId, RunId, RunOrdinal } from "../domain/run.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import { EntryId } from "./memory-log.entity.js"
import type { LogEntry } from "./memory-log.entity.js"
import { toolInputOf, toolInputsByResult } from "./memory-log.entity.functions.js"

const runId = RunId.make("batch-input-run")
const request = (id: string, ordinal: number, step = 0): LogEntry => ({ id: EntryId.make(id), runId, turn: 1, step, at: 1, body: { _tag: "Message", run: RunOrdinal.make(ordinal), message: { role: "assistant", content: [{ type: "tool-call", toolName: "read", toolCallId: ToolCallId.make("reused"), input: { request: id } }] } } })
const result = (id: string, ordinal: number, step = 0): LogEntry => ({ id: EntryId.make(id), runId, turn: 1, step, at: 2, body: { _tag: "ToolResult", run: RunOrdinal.make(ordinal), toolName: "read", toolCallId: ToolCallId.make("reused"), encoded: "answer", view: "answer", viewVersion: "raw", isError: false, subjects: [], artifacts: [], pinned: false } })

test("batch inputs preserve scoped reused ids, original ordinals, missing requests and intercepted null", () => {
  const first = result("first-result", 0)
  const missing = result("missing-result", 0, 8)
  const base = result("rewritten-result", 1)
  const rewritten: LogEntry = base.body._tag === "ToolResult" ? { ...base, body: { ...base.body, interception: { invocationId: InvocationId.make("rewritten"), effectiveInput: null } } } : base
  const entries = [request("first-request", 0), request("second-request", 1), request("other-step-request", 0, 1), first, missing, rewritten]
  const inputs = toolInputsByResult(entries)
  expect([...inputs.keys()]).toEqual([first.id, missing.id, rewritten.id])
  expect(inputs.get(first.id)).toEqual({ request: "first-request" })
  expect(inputs.get(missing.id)).toEqual({})
  expect(inputs.get(rewritten.id)).toBeNull()
  expect(entries.filter((entry) => entry.body._tag === "ToolResult").every((entry) => JSON.stringify(inputs.get(entry.id)) === JSON.stringify(toolInputOf(entries, entry)))).toBe(true)
})
