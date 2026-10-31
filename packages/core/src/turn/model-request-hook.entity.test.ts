import { expect, test } from "bun:test"
import { Effect, Option, Result, Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { ModelRequestHook } from "../ports/model-request-hook.port.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import type { SessionLogEvent } from "../session/session-log.entity.js"
import { ModelRequestDraft } from "./model-request-hook.entity.js"
import { resolveRequestHeader } from "./model-request-header.entity.functions.js"
import { ModelRequestHeader } from "./model-request.entity.js"
import { prepareRequestParts } from "./request-part.entity.functions.js"

const session = ConversationId.make("00000000-0000-4000-8000-000000000028")
const wire = { version: 1, runId: "hook-header", run: 0, step: 0, strategyVersion: "1", system: "effective system",
  render: { strategy: "window", currentTurn: 1, currentRun: "hook-header", run: 0, turnContext: "current", replies: true, stepContext: "tail", digests: true, media: { mode: "none", maxImages: 8, maxChars: 20_000_000 } },
  through: null, contextFingerprint: "fingerprint", stableMessages: 0, tools: [], toolChoice: "auto", model: null, cacheKey: null, callPolicy: null } as const

test("old no-hook materialized headers retain exactly their encoded fields", async () => {
  const header = await Effect.runPromise(Schema.decodeUnknownEffect(ModelRequestHeader)(wire))
  expect(await Effect.runPromise(Schema.encodeEffect(ModelRequestHeader)(header))).toEqual(wire)
  expect(Object.hasOwn(header, "hook")).toBe(false)
})

test("V1 and referenced V2 retain accepted hook metadata without reapplying a hook", async () => {
  const hook = { system: "effective system", context: "one host context", toolChoice: null }
  const calls: number[] = []
  const result = await Effect.runPromise(Effect.gen(function* () {
    const header = yield* Schema.decodeUnknownEffect(ModelRequestHeader)({ ...wire, hook })
    const prepared = yield* prepareRequestParts(header)
    const parts = yield* Effect.forEach(prepared.parts, (part, index) => storedJson(part).pipe(Effect.map((data): SessionLogEvent => ({ session, seq: index + 1, at: 0, turn: Option.some(1), kind: "request.part", data }))), { concurrency: 1 })
    const v1: SessionLogEvent = { session, seq: 10, at: 0, turn: Option.some(1), kind: "request.prepared", data: yield* storedJson({ ...wire, hook }) }
    const v2: SessionLogEvent = { ...v1, seq: 11, data: yield* storedJson(prepared.header) }
    return { v1: yield* resolveRequestHeader([v1], v1), v2: yield* resolveRequestHeader([...parts, v2], v2) }
  }).pipe(Effect.provideService(ModelRequestHook, { prepare: () => Effect.sync(() => { calls.push(1); return Result.getOrThrow(Result.fail(new Error("replay must never call today's hook"))) }) })))
  expect(result.v1.hook).toEqual(hook)
  expect(result.v2.hook).toEqual(hook)
  expect(result.v2).toEqual(result.v1)
  expect(calls).toEqual([])
})

test("draft run identity contains the complete turn and ordinal, with a nonnegative step", () => {
  const value = { run: { id: "hook-run", turn: 3, ordinal: 1 }, step: 0, activeTools: [], system: "base", context: null, toolChoice: null }
  expect(Option.isSome(Schema.decodeUnknownOption(ModelRequestDraft)(value))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(ModelRequestDraft)({ ...value, step: -1 }))).toBe(true)
  expect(Option.isNone(Schema.decodeUnknownOption(ModelRequestDraft)({ ...value, run: { id: "hook-run", ordinal: 1 } }))).toBe(true)
})
