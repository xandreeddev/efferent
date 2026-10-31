import { expect, test } from "bun:test"
import { Cause, Effect, Exit, MutableRef, Option, Schema } from "effect"
import {
  ConversationId, InboxItemId, InvocationId, RunId, RunOrdinal, StreamPartId, ToolCallId, TurnEvent, UserMessage,
} from "@xandreed/core"
import type { SessionLogEvent, TurnEventOf } from "@xandreed/core"
import { ProcessPeerError } from "./process-peer.entity.js"
import { ProcessEvent, ProcessRequestId } from "./process-protocol.entity.js"
import { decodeProcessCommand, encodeProcessEvent, processLifecycleOf, processProgressOf } from "./process-protocol.entity.functions.js"

const secret = "SECRET-OMITTED-CONTENT"
const session = { id: ConversationId.make("10000000-0000-4000-8000-000000000001"), owner: "host" }
const runId = RunId.make("run:1")
const requestId = ProcessRequestId.make("request:1")
const invocationId = InvocationId.make("run:1:call:1")
const toolCallId = ToolCallId.make("call:1")
const run = RunOrdinal.make(0)
const usage = { inputTokens: 7, outputTokens: 2, totalTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
const tool = (result: unknown): TurnEventOf<"tool.completed"> => ({
  _tag: "tool.completed", step: 1, invocationId, toolCallId, tool: "lookup", input: { secret }, result, encoded: { secret },
  ok: true, durationMs: 7, labels: { secret }, stage: Option.some(secret),
})
const progressFrame = (progress: Extract<ProcessEvent, { readonly _tag: "turn.event" }>["progress"]): ProcessEvent => ({
  _tag: "turn.event", session, turn: 1, runId, progress,
})
const projected = (event: TurnEvent) => Effect.runPromise(processProgressOf(event, "projection")).then((value) => Option.getOrThrow(value).event)

test("projection exports tool identity/status and never reads raw tool values", async () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  const source = Object.defineProperty(tool(cycle), "input", { enumerable: true, get: () => new Uint8Array(-1) })
  expect(await projected(source)).toEqual({ _tag: "tool.completed", step: 1, invocationId, toolCallId, tool: "lookup", ok: true })
  const start: TurnEventOf<"tool.started"> = { ...tool(1n), _tag: "tool.started" }
  expect(await projected(start)).toEqual({ _tag: "tool.started", step: 1, invocationId, toolCallId, tool: "lookup" })
  const refusal: TurnEventOf<"tool.refused"> = { _tag: "tool.refused", step: 1, invocationId, toolCallId, tool: "lookup", input: { secret }, reason: "denied", message: secret }
  expect(await projected(refusal)).toEqual({ _tag: "tool.refused", step: 1, invocationId, toolCallId, tool: "lookup", reason: "denied" })
})

test("projection retains assistant text and text deltas while excluding reasoning/tool parameters", async () => {
  expect(await projected({ _tag: "assistant.message", step: 1, run, text: "Visible answer", reasoning: secret, model: Option.some(secret), toolCalls: [{ id: toolCallId, tool: "lookup", input: { secret } }], usage, finishReason: "stop" })).toEqual({
    _tag: "assistant.message", step: 1, run, text: "Visible answer",
  })
  const delta: TurnEventOf<"assistant.delta"> = { _tag: "assistant.delta", step: 1, channel: "text", id: StreamPartId.make("part:1"), delta: "Visible text" }
  expect(await projected(delta)).toEqual({ _tag: "assistant.delta", step: 1, id: delta.id, delta: "Visible text" })
  expect(Option.isNone(await Effect.runPromise(processProgressOf({ ...delta, channel: "reasoning", delta: secret }, "projection")))).toBe(true)
  expect(Option.isNone(await Effect.runPromise(processProgressOf({ ...delta, channel: "tool-params", delta: secret }, "projection")))).toBe(true)
})

test("projection pins step status, tool status text and fallback marker without provider error text", async () => {
  expect(await projected({ _tag: "step.started", step: 0, run, planned: true, activeTools: [secret] })).toEqual({ _tag: "step.started", step: 0, run, planned: true })
  expect(await projected({ _tag: "step.ended", step: 1, run, status: "failed", results: [] })).toEqual({ _tag: "step.ended", step: 1, run, status: "failed" })
  expect(await projected({ _tag: "stream.fallback", step: 1, run, message: secret })).toEqual({ _tag: "stream.fallback", step: 1, run })
  const status: TurnEventOf<"tool.progress"> = { _tag: "tool.progress", step: 1, invocationId, tool: "lookup", channel: "status", text: "Working" }
  expect(await projected(status)).toEqual({ _tag: "tool.progress", step: 1, invocationId, tool: "lookup", text: "Working" })
  expect(Option.isNone(await Effect.runPromise(processProgressOf({ ...status, channel: "stdout", text: secret }, "projection")))).toBe(true)
  expect(Option.isNone(await Effect.runPromise(processProgressOf({ ...status, channel: "stderr", text: secret }, "projection")))).toBe(true)
})

test("full content preserves decoded, encoded, reasoning and metadata fields instead of clipping", async () => {
  const source = tool({ answer: [1, true, null, { nested: "decoded" }] })
  const progress = Option.getOrThrow(await Effect.runPromise(processProgressOf(source, "full")))
  expect(progress).toEqual({ mode: "full", event: { ...source, stage: secret } })
  const text = await Effect.runPromise(encodeProcessEvent(progressFrame(progress)))
  expect(text.endsWith("\n")).toBe(false)
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.fromJsonString(ProcessEvent))(text))
  expect(decoded).toEqual(progressFrame(progress))
  const message: TurnEventOf<"assistant.message"> = { _tag: "assistant.message", step: 1, run, text: "Visible", reasoning: "Full reasoning", model: Option.none(), toolCalls: [], usage, finishReason: "stop" }
  expect(Option.getOrThrow(await Effect.runPromise(processProgressOf(message, "full"))).event).toEqual({ ...message, model: null })
})

test("bus lifecycle is omitted in both progress modes", async () => {
  const events: ReadonlyArray<TurnEvent> = [
    { _tag: "turn.started", runId, turn: 1, userMessage: new UserMessage({ text: secret }), meta: { secret } },
    { _tag: "turn.ended", runId, turn: 1, outcome: "completed", reply: Option.some(secret), usage },
  ]
  await Effect.runPromise(Effect.forEach(events, (source) => Effect.gen(function* () {
    expect(Option.isNone(yield* processProgressOf(source, "projection"))).toBe(true)
    expect(Option.isNone(yield* processProgressOf(source, "full"))).toBe(true)
  }), { concurrency: 1 }))
})

test("non-UI events are omitted by default", async () => {
  const encoded = [
    { _tag: "host", name: "app.private", data: { secret } },
    { _tag: "completion.evaluated", step: 1, run: 0, verdict: { complete: true, awaiting: [], facts: { secret } } },
    { _tag: "skills.activated", skills: [secret], tools: [secret], source: "host" },
    { _tag: "context.built", step: 1, turn: 1, run: 0, strategy: secret, strategyVersion: secret, fingerprint: secret, systemFingerprint: secret, estimatedTokens: 1, reservedTokens: 1, budgetTokens: 10, compactions: 0, activeTools: [secret] },
    { _tag: "tool.intercepted", invocationId, tool: "lookup", run: null, step: 1, phase: { _tag: "Before", decision: { _tag: "Rewrite", input: { secret } } } },
    { _tag: "model.called", callId: "call:1", attempt: 1, purpose: "Helper", method: "Text", model: null, runId: null, run: null, step: null, durationMs: 0, usage: { _tag: "Unknown" }, outcome: { _tag: "Completed" } },
    { _tag: "decision.recorded", record: { version: 1, id: "decision:1", family: "test", contextHash: secret, candidateHash: secret, policyVersion: secret, candidates: [{ id: "candidate:1", description: secret }], attempts: [secret], selection: secret, validation: "accepted", fallback: secret, applied: secret, probabilities: null } },
  ]
  await Effect.runPromise(Effect.forEach(encoded, (value) => Effect.gen(function* () {
    const source = yield* Schema.decodeUnknownEffect(TurnEvent)(value)
    expect(Option.isNone(yield* processProgressOf(source, "projection"))).toBe(true)
    expect(Option.isSome(yield* processProgressOf(source, "full"))).toBe(true)
  }), { concurrency: 1 }))
})

test("full export rejects non-JSON decoded values with an owned fixed error and projection still works", async () => {
  const cycle: Record<string, unknown> = {}
  cycle.self = cycle
  const values = [1n, cycle, () => secret, undefined, NaN, Infinity, new Date("2000-01-01T00:00:00.000Z")]
  await Effect.runPromise(Effect.forEach(values, (value) => Effect.gen(function* () {
    const result = yield* Effect.exit(processProgressOf(tool(value), "full"))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(Cause.hasDies(result.cause)).toBe(false)
      const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
      expect(error._tag).toBe("ProcessPeerError")
      expect(error.reason).toBe("InvalidEvent")
      expect(error.direction).toBe("output")
      expect(error.message).toBe("The process event could not be encoded")
      expect(error.message).not.toContain(secret)
    }
    expect(Option.getOrThrow(yield* processProgressOf(tool(value), "projection")).event).toEqual({ _tag: "tool.completed", step: 1, invocationId, toolCallId, tool: "lookup", ok: true })
  }), { concurrency: 1 }))
})

test("full export snapshots getters once and drops inherited toJSON without invoking it", async () => {
  const getterCalls = MutableRef.make(0)
  const hookCalls = MutableRef.make(0)
  const value = Object.defineProperty(Object.create(Object.assign(Object.create(null), { toJSON: () => { hookCalls.current += 1; return { replaced: true } } })), "answer", {
    enumerable: true, get: () => { getterCalls.current += 1; return 7 },
  })
  const progress = Option.getOrThrow(await Effect.runPromise(processProgressOf(tool(value), "full")))
  const text = await Effect.runPromise(encodeProcessEvent(progressFrame(progress)))
  expect(getterCalls.current).toBe(1)
  expect(hookCalls.current).toBe(0)
  expect(text).toContain('"result":{"answer":7}')
  expect(text).not.toContain("replaced")
})

test("direct typed full frames receive the same snapshot policy before schema validation", async () => {
  const getterCalls = MutableRef.make(0)
  const hookCalls = MutableRef.make(0)
  const result = Object.defineProperty(Object.create(Object.assign(Object.create(null), { toJSON: () => { hookCalls.current += 1; return { replaced: true } } })), "answer", {
    enumerable: true, get: () => { getterCalls.current += 1; return 7 },
  })
  const native = tool(result)
  const text = await Effect.runPromise(encodeProcessEvent(progressFrame({ mode: "full", event: { ...native, stage: secret } })))
  expect(getterCalls.current).toBe(1)
  expect(hookCalls.current).toBe(0)
  expect(text).toContain('"result":{"answer":7}')
  const failed = await Effect.runPromiseExit(encodeProcessEvent(progressFrame({ mode: "full", event: { ...native, result: 1n, stage: secret } })))
  expect(Exit.isFailure(failed)).toBe(true)
})

test("codec/getter defects are typed while actual interruptions stay interruptions", async () => {
  const broken = Object.defineProperty(tool({}), "input", { enumerable: true, get: () => new Uint8Array(-1) })
  const defect = await Effect.runPromiseExit(processProgressOf(broken, "full"))
  expect(Exit.isFailure(defect)).toBe(true)
  if (Exit.isFailure(defect)) {
    expect(Cause.hasDies(defect.cause)).toBe(false)
    expect(Option.getOrThrow(Cause.findErrorOption(defect.cause)).message).toBe("The process event could not be encoded")
  }
  const brokenTag = Object.defineProperty(tool({}), "_tag", { enumerable: true, get: () => new Uint8Array(-1) })
  const tagDefect = await Effect.runPromiseExit(processProgressOf(brokenTag, "full"))
  expect(Exit.isFailure(tagDefect)).toBe(true)
  if (Exit.isFailure(tagDefect)) {
    expect(Cause.hasDies(tagDefect.cause)).toBe(false)
    expect(Option.getOrThrow(Cause.findErrorOption(tagDefect.cause)).reason).toBe("InvalidEvent")
  }
  const interrupted = await Effect.runPromiseExit(Effect.interrupt.pipe(Effect.andThen(processProgressOf(tool({}), "full"))))
  expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)
})

test("command parse failures expose no malformed frame or unknown-field content", async () => {
  await Effect.runPromise(Effect.forEach([`{"_tag":"ping","requestId":"p","secret":"${secret}"}`, `{${secret}`, `{"_tag":"hello","requestId":"h","protocolVersion":0}`], (text) => Effect.gen(function* () {
    const result = yield* Effect.exit(decodeProcessCommand(text))
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const error = Option.getOrThrow(Cause.findErrorOption(result.cause))
      expect(error.reason).toBe("InvalidFrame")
      expect(error.message).toBe("The process command is invalid")
      expect(error.message).not.toContain(secret)
    }
  }), { concurrency: 1 }))
})

test("lifecycle projection keeps admitted identity/cursor and excludes input/meta/error text", async () => {
  const started: SessionLogEvent = {
    session: session.id, seq: 1, at: 100, turn: Option.some(1), kind: "turn.started",
    data: { runId, key: secret, origin: "task", userMessage: { text: secret }, command: { secret }, claimed: ["notice:1"], input: "input:1", entry: "run:1:1", at: 100, meta: { secret }, resumes: 1, task: { taskId: session.id, parent: session.id } },
  }
  expect(Option.getOrThrow(await Effect.runPromise(processLifecycleOf(session, started, requestId)))).toEqual({
    _tag: "turn.started", requestId, session, turn: 1, runId, origin: "task", input: InboxItemId.make("input:1"), resumes: 1, task: { taskId: session.id, parent: session.id }, journal: { seq: 1, at: 100 },
  })
  const ended: SessionLogEvent = { ...started, seq: 2, at: 101, kind: "turn.ended", data: { reason: "interrupted", failure: { code: "turn.shutdown", message: secret } } }
  const frame = Option.getOrThrow(await Effect.runPromise(processLifecycleOf(session, ended)))
  expect(frame).toEqual({ _tag: "turn.ended", session, turn: 1, reason: "interrupted", failureCode: "turn.shutdown", journal: { seq: 2, at: 101 } })
  expect(await Effect.runPromise(encodeProcessEvent(frame))).not.toContain(secret)
  expect(Option.isNone(await Effect.runPromise(processLifecycleOf(session, { ...started, kind: "turn.reply" })))).toBe(true)
  const missingTurn = await Effect.runPromiseExit(processLifecycleOf(session, { ...ended, turn: Option.none() }))
  expect(Exit.isFailure(missingTurn)).toBe(true)
})

test("a deep JSON value never escapes as an untyped defect", async () => {
  const deep = Array.from({ length: 20_000 }).reduce<unknown>((child) => ({ child }), {})
  const result = await Effect.runPromiseExit(processProgressOf(tool(deep), "full"))
  if (Exit.isFailure(result)) {
    expect(Cause.hasDies(result.cause)).toBe(false)
    expect(Option.getOrThrow(Cause.findErrorOption(result.cause))._tag).toBe("ProcessPeerError")
  } else {
    expect(Option.isSome(result.value)).toBe(true)
  }
})

// A host can match peer errors without serializing their private causes.
const ownedFailure: Effect.Effect<never, ProcessPeerError> = Effect.fail(new ProcessPeerError({ reason: "InvalidEvent", direction: "output", message: "The process event could not be encoded" }))
void ownedFailure
