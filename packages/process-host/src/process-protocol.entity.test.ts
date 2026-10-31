import { expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import type { NewTurn, TurnResult } from "@xandreed/core"
import { ProcessCommand, ProcessEvent, ProcessRequestId, ProcessTurnResult } from "./process-protocol.entity.js"

const address = { id: "10000000-0000-4000-8000-000000000001", owner: "host" }
const begin = { _tag: "begin", requestId: "begin:1", session: address, runId: "run:1", userMessage: { text: "hello" } }
const strict = { onExcessProperty: "error" } as const
const command = Schema.decodeUnknownOption(ProcessCommand, strict)
const event = Schema.decodeUnknownOption(ProcessEvent, strict)

// These assignments fail compilation if the protocol stops matching the actual serializable runner contract.
const newTurnOf = (value: Extract<ProcessCommand, { readonly _tag: "begin" }>): NewTurn => value
const resultOf = (value: ProcessTurnResult): TurnResult => value
const protocolResultOf = (value: TurnResult): ProcessTurnResult => value

test("begin is the serializable NewTurn shape and preserves omitted options", async () => {
  const decoded = await Effect.runPromise(Schema.decodeUnknownEffect(ProcessCommand)(begin, strict))
  expect(decoded._tag).toBe("begin")
  if (decoded._tag !== "begin") return
  expect(newTurnOf(decoded)).toMatchObject({ session: address, runId: "run:1", userMessage: { text: "hello" } })
  expect(Object.hasOwn(decoded, "takeOver")).toBe(false)
  expect(Object.hasOwn(decoded, "resumes")).toBe(false)
  expect(Option.isSome(command({ ...begin, key: "", takeOver: true, resumes: 1, timeLimitMs: 1 }))).toBe(true)
})

test("request IDs have exact ASCII bounds including rejection of a final newline", () => {
  const decode = Schema.decodeUnknownOption(ProcessRequestId)
  expect(Option.isSome(decode("AZaz09_.:-"))).toBe(true)
  expect(Option.isSome(decode("a".repeat(128)))).toBe(true)
  ;["", "a".repeat(129), " x", "x ", "x\n", "x\r", "x\t", "x y", "é", "x/1", "😀"].forEach((input) => {
    expect(Option.isNone(decode(input))).toBe(true)
  })
})

test("nested command shapes reject extra fields and do not accept delivery over send/steer", () => {
  ;[
    { ...begin, model: "hidden" },
    { ...begin, session: { ...address, hidden: true } },
    { ...begin, userMessage: { text: "hello", hidden: true } },
    { _tag: "send", requestId: "s", session: address, input: { id: "input:1", userMessage: { text: "hi" }, source: {}, delivery: "next" } },
    { _tag: "steer", requestId: "s", session: address, input: { id: "input:1", userMessage: { text: "hi" }, source: {}, delivery: "steer" } },
  ].forEach((input) => expect(Option.isNone(command(input))).toBe(true))
})

test("protocol integer inputs reject fractional, infinite, negative and unsafe values", () => {
  ;[0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1].forEach((value) => {
    expect(Option.isNone(command({ ...begin, resumes: value }))).toBe(true)
    expect(Option.isNone(command({ ...begin, timeLimitMs: value }))).toBe(true)
    expect(Option.isNone(command({ _tag: "cancel", requestId: "c", session: address, turn: value }))).toBe(true)
  })
  expect(Option.isSome(command({ _tag: "hello", requestId: "h", protocolVersion: 2 }))).toBe(true)
  expect(Option.isSome(command({ _tag: "shutdown", requestId: "q", deadlineMs: 0 }))).toBe(true)
  expect(Option.isNone(command({ _tag: "shutdown", requestId: "q", deadlineMs: -1 }))).toBe(true)
})

test("lifecycle frames cannot carry message content or failure messages even for full mode", () => {
  const started = { _tag: "turn.started", session: address, turn: 1, runId: "r", origin: "user", journal: { seq: 1, at: 100 } }
  const ended = { _tag: "turn.ended", session: address, turn: 1, reason: "interrupted", failureCode: "turn.shutdown", journal: { seq: 2, at: 101 } }
  expect(Option.isSome(event(started))).toBe(true)
  expect(Option.isSome(event(ended))).toBe(true)
  expect(Option.isNone(event({ ...started, userMessage: { text: "secret" } }))).toBe(true)
  expect(Option.isNone(event({ ...started, meta: { secret: true } }))).toBe(true)
  expect(Option.isNone(event({ ...ended, failure: { code: "turn.shutdown", message: "secret" } }))).toBe(true)
  expect(Option.isNone(event({ ...ended, message: "secret" }))).toBe(true)
  expect(Option.isNone(event({ ...ended, runId: "invented" }))).toBe(true)
})

test("result usage/reply encode with the actual runner contract", async () => {
  const result: ProcessTurnResult = {
    outcome: "waiting", reply: Option.none(), usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }
  const encoded = await Effect.runPromise(Schema.encodeEffect(ProcessTurnResult)(protocolResultOf(resultOf(result))))
  expect(encoded).toEqual({ outcome: "waiting", reply: null, usage: result.usage })
  expect(Object.hasOwn(encoded, "pending")).toBe(false)
})

test("full progress has actual encoded event fields and cannot include bus lifecycle", () => {
  const identity = { _tag: "turn.event", session: address, turn: 1, runId: "r" }
  expect(Option.isSome(event({ ...identity, progress: { mode: "full", event: { _tag: "host", name: "app.progress", data: { count: 1 } } } }))).toBe(true)
  expect(Option.isNone(event({ ...identity, progress: { mode: "full", event: { _tag: "tool.started" } } }))).toBe(true)
  expect(Option.isNone(event({ ...identity, progress: { mode: "full", event: { _tag: "turn.ended", runId: "r", turn: 1, outcome: "completed", reply: null, usage: {} } } }))).toBe(true)
  expect(Option.isNone(event({ ...identity, progress: { mode: "projection", event: { _tag: "host", name: "app.progress", data: {} } } }))).toBe(true)
})
