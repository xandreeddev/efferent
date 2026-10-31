import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { InvocationId, RunId, RunOrdinal } from "../domain/run.entity.js"
import { ToolCallId } from "../domain/message.entity.js"
import { EntryId, LogEntry } from "./memory-log.entity.js"
import { presentedEntries, toolInputOf } from "./memory-log.entity.functions.js"

import { prepareMemorySnapshot, validateMemorySnapshot, projectMemorySnapshot } from "./memory-snapshot.entity.functions.js"
import { MemoryStrategyId } from "./memory-snapshot.entity.js"
import { memorySnapshotFixture, memorySnapshotOptions } from "./memory-snapshot.conformance.js"

const runId = RunId.make("interception-run")
const request: LogEntry = { id: EntryId.make("r:1"), runId, turn: 1, step: 0, at: 0, body: { _tag: "Message", run: RunOrdinal.make(0), message: { role: "assistant", content: [{ type: "tool-call", toolName: "read", toolCallId: ToolCallId.make("same"), input: { path: "original" } }] } } }
const result = { id: EntryId.make("r:2"), runId, turn: 1, step: 0, at: 0, body: { _tag: "ToolResult", run: RunOrdinal.make(0), toolName: "read", toolCallId: ToolCallId.make("same"), encoded: "answer", view: "answer", viewVersion: "raw", isError: false, subjects: [], artifacts: [], pinned: false } } satisfies LogEntry

test("a rewritten result prefers its own durable effective input and leaves its request unchanged", () => {
  const rewritten: LogEntry = { ...result, body: { ...result.body, interception: { invocationId: InvocationId.make("r:call:1"), effectiveInput: { path: "rewritten" } } } }
  expect(toolInputOf([request, rewritten], rewritten)).toEqual({ path: "rewritten" })
  expect(request.body._tag === "Message" && request.body.message.role === "assistant" && request.body.message.content[0]).toEqual({ type: "tool-call", toolName: "read", toolCallId: ToolCallId.make("same"), input: { path: "original" } })
})

test("explicit null input is retained and absence falls back to the original scoped request", () => {
  const rewritten: LogEntry = { ...result, body: { ...result.body, interception: { invocationId: InvocationId.make("r:call:1"), effectiveInput: null } } }
  expect(toolInputOf([request, rewritten], rewritten)).toBeNull()
  expect(toolInputOf([request, result], result)).toEqual({ path: "original" })
})

test("presentation overlays and checkpoint encoding retain raw interception identity once", async () => {
  const full = memorySnapshotFixture().map((entry): LogEntry => entry.id === "r1:6" && entry.body._tag === "ToolResult" ? { ...entry, body: { ...entry.body, interception: { invocationId: InvocationId.make("r1:call:0"), effectiveInput: null } } } : entry)
  const shown = presentedEntries(full).find((entry) => entry.id === "r1:6")
  expect(shown?.body._tag === "ToolResult" && shown.body.interception).toEqual({ invocationId: InvocationId.make("r1:call:0"), effectiveInput: null })
  const strategy = { id: MemoryStrategyId.make("summary"), version: "2" }
  const candidate = Option.getOrThrow(await Effect.runPromise(prepareMemorySnapshot(full, strategy)))
  const copied = await Effect.runPromise(Schema.encodeEffect(Schema.Array(LogEntry))(candidate.entries).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(LogEntry)))))
  const phase = await Effect.runPromise(validateMemorySnapshot(full, { ...candidate, entries: copied }, strategy, memorySnapshotOptions()[0]!))
  const projected = projectMemorySnapshot(full, phase, memorySnapshotOptions()[0]!)
  expect(projected.phase._tag).toBe("Projected")
  const raw = projected.entries.find((entry) => entry.id === "r1:6")
  expect(raw?.body._tag === "ToolResult" && raw.body.interception).toEqual({ invocationId: InvocationId.make("r1:call:0"), effectiveInput: null })
})
