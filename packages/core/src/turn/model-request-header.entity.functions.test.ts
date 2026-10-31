import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { buildContext, canonicalJson } from "../memory/memory-log.entity.functions.js"
import { entriesOfEvents, readStored } from "../session/session-event.entity.functions.js"
import { JOURNAL_KINDS, MEMORY_KINDS, RESERVED_KINDS } from "../session/session-event.entity.js"
import { storedJson } from "../session/session-log.entity.functions.js"
import type { JsonObject, SessionLogEvent } from "../session/session-log.entity.js"
import { resolveRequestHeader } from "./model-request-header.entity.functions.js"
import { ModelRequestHeaderV2, StoredModelRequestHeader } from "./model-request-header.entity.js"
import { modelRequestHeaderOf, reconstructModelRequest, replayModelRequest } from "./model-request.entity.functions.js"
import { ModelRequestHeader } from "./model-request.entity.js"
import { RequestPartHash } from "./request-part.entity.js"

const session = ConversationId.make("00000000-0000-4000-8000-00000000a731")
const run = RunId.make("request-run")
const hash = "814d76f8a074500fd06a82c3589082ed4a3ed1281ae584ab9fa698fd2287e37b"
const toolHash = "09602a19a0b820b8fa4e8ec5efa087cf8f829ce27207af5e2606031bd0e8364b"
const rawTool = { name: "first", description: "First tool.", parameters: { type: "object", properties: {} }, provider: null }
const rawRecipe = { strategy: "window", currentTurn: 1, currentRun: "request-run", turnContext: "current", replies: true, stepContext: "tail", digests: true, media: { mode: "none", maxImages: 8 } }
const raw = (): JsonObject => ({
  version: 2, runId: run, step: 0, strategyVersion: "1", system: hash, render: rawRecipe,
  through: null, contextFingerprint: "f", tools: [toolHash], toolChoice: "auto", model: null, cacheKey: null, callPolicy: null,
})
const event = (seq: number, kind: string, data: JsonObject): SessionLogEvent => ({ session, seq, kind, data, at: 0, turn: Option.some(1) })
const system = event(1, "request.part", { hash, part: { _tag: "System", text: "system α" } })
const tool = event(2, "request.part", { hash: toolHash, part: { _tag: "Tool", tool: rawTool } })
const prepared = (seq = 3, overrides: JsonObject = {}) => event(seq, "request.prepared", { ...raw(), ...overrides })
const failure = (events: ReadonlyArray<SessionLogEvent>, at = { session, seq: 3 }) => Effect.runPromise(resolveRequestHeader(events, at).pipe(
  Effect.match({ onFailure: (error) => ({ code: error.code, message: error.message, cause: error.cause }), onSuccess: () => ({ code: "success", message: "", cause: undefined }) }),
))

describe("referenced request header schemas", () => {
  test("hashes require exactly lowercase SHA-256 hex", () => {
    expect([hash, hash.toUpperCase(), hash.slice(1), `${hash}0`, "g".repeat(64), ""].map((value) => Option.isSome(Schema.decodeUnknownOption(RequestPartHash)(value)))).toEqual([true, false, false, false, false, false])
  })

  test("stored V2 remains V2 while the original public header schema stays materialized V1", async () => {
    const record = prepared()
    const [stored] = await Effect.runPromise(readStored("request.prepared", [record]))
    expect(stored?.data.version).toBe(2)
    expect(Option.isSome(Schema.decodeUnknownOption(ModelRequestHeaderV2)(record.data))).toBe(true)
    expect(Option.isSome(Schema.decodeUnknownOption(ModelRequestHeader)(record.data))).toBe(false)
    expect(Option.isSome(Schema.decodeUnknownOption(StoredModelRequestHeader)({ ...record.data, version: 3 }))).toBe(false)
    const resolved = await Effect.runPromise(resolveRequestHeader([system, tool, record], record))
    expect(resolved.version).toBe(1)
    expect(resolved.run).toBe(RunOrdinal.make(0))
    expect(resolved.render.run).toBe(RunOrdinal.make(0))
    expect(resolved.render.media.maxChars).toBe(20_000_000)
    expect(resolved.stableMessages).toBeUndefined()
    expect(resolved.tools[0]?.provider).toEqual(Option.none())
  })

  test("request parts are reserved durable protocol facts without memory entries", async () => {
    expect(JOURNAL_KINDS.indexOf("request.part")).toBe(JOURNAL_KINDS.indexOf("model.called") + 1)
    expect(RESERVED_KINDS.includes("request.part")).toBe(true)
    expect(MEMORY_KINDS.includes("request.part")).toBe(false)
    const stored = await Effect.runPromise(readStored("request.part", [system, tool]))
    expect(stored.map((row) => row.data.part._tag)).toEqual(["System", "Tool"])
    expect(await Effect.runPromise(entriesOfEvents([system, tool]))).toEqual([])
  })
})

describe("selected durable prefix resolution", () => {
  test("header key-first lookup selects the latest matching V2 without decoding unrelated full bodies", async () => {
    const bad = prepared(4, { runId: "another-run", system: 42, version: 77 })
    const last = prepared(5, { stableMessages: 0, run: 1 })
    const found = await Effect.runPromise(modelRequestHeaderOf([system, tool, prepared(), bad, last], run, 0, RunOrdinal.make(1)))
    expect(found.system).toBe("system α")
    expect(found.stableMessages).toBe(0)
    expect(found.run).toBe(RunOrdinal.make(1))
    const invalidKey = prepared(6, { runId: 7 })
    const result = await Effect.runPromise(Effect.result(modelRequestHeaderOf([system, tool, last, invalidKey], run, 0, RunOrdinal.make(1))))
    expect(result._tag === "Failure" ? result.failure.code : "success").toBe("request.decode")
  })

  test("a supplied selector cannot substitute a different body for the stored event", async () => {
    const record = prepared()
    const forgedSelector = { ...record, data: { ...record.data, system: "forged" } }
    expect((await Effect.runPromise(resolveRequestHeader([system, tool, record], forgedSelector))).system).toBe("system α")
    expect((await failure([system, tool, record, { ...record }])).code).toBe("request.diverged")
  })

  test("future conflicts and bad keys do not poison an earlier prefix; future facts cannot heal it", async () => {
    const future = event(4, "request.part", { hash: "not-a-hash", part: {} })
    expect((await Effect.runPromise(resolveRequestHeader([system, tool, prepared(), future], prepared()))).system).toBe("system α")
    expect((await failure([tool, prepared(), { ...system, seq: 4 }])).code).toBe("request.diverged")
    expect((await failure([system, tool, future, prepared(5)], { session, seq: 5 })).code).toBe("request.decode")
  })

  test("wrong tool tags and undecodable referenced payloads retain category and cause", async () => {
    const wrong = prepared(3, { tools: [hash] })
    expect(await failure([system, wrong])).toMatchObject({ code: "request.diverged", message: "tools: the referenced request part has the wrong tag" })
    const damaged = event(1, "request.part", { hash, part: { _tag: "System", text: 42 } })
    const failed = await failure([damaged, tool, prepared()])
    expect(failed.code).toBe("request.diverged")
    expect(failed.message.startsWith("system:")).toBe(true)
    expect(failed.cause).toBeDefined()
  })

  test("returned materialized data is detached from the input journal", async () => {
    const choice = { mode: "original" }
    const record = prepared(3, { toolChoice: choice })
    const resolved = await Effect.runPromise(resolveRequestHeader([system, tool, record], record))
    choice.mode = "mutated"
    expect(resolved.toolChoice).toEqual({ mode: "original" })
    rawTool.parameters.type = "mutated"
    expect(resolved.tools[0]?.parameters).toEqual({ type: "object", properties: {} })
    rawTool.parameters.type = "object"
  })

  test("a V1 header needs no part keys and preserves existing full replay bytes", async () => {
    const full = Schema.decodeUnknownSync(ModelRequestHeader)({ ...raw(), version: 1, system: "system α", tools: [rawTool], stableMessages: 0 })
    const built = buildContext([], full.render)
    const matching = { ...full, contextFingerprint: built.fingerprint }
    const v1 = event(3, "request.prepared", await Effect.runPromise(Schema.encodeEffect(ModelRequestHeader)(matching).pipe(Effect.flatMap(storedJson))))
    const v2 = prepared(3, { contextFingerprint: built.fingerprint, stableMessages: 0 })
    const [old, current, expected] = await Effect.runPromise(Effect.all([
      replayModelRequest([event(1, "request.part", { hash: "bad" }), v1], run, 0),
      replayModelRequest([system, tool, v2, event(4, "request.part", { hash, part: { _tag: "System", text: "later" } })], run, 0),
      reconstructModelRequest(matching, []),
    ], { concurrency: 1 }))
    expect(canonicalJson(old)).toBe(canonicalJson(expected))
    expect(canonicalJson(current)).toBe(canonicalJson(expected))
  })
})
