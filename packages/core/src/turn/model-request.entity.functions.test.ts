import { describe, expect, test } from "bun:test"
import { Effect, Option, Schema } from "effect"
import { Prompt } from "effect/ai"
import { ConversationId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { buildContext, canonicalJson, entryId } from "../memory/memory-log.entity.functions.js"
import type { LogEntry } from "../memory/memory-log.entity.js"
import type { JsonObject, SessionLogEvent } from "../session/session-log.entity.js"
import { isVolatileContext } from "../internal/volatile-context.entity.functions.js"
import { checkModelRequest, modelRequestHeaderOf, reconstructModelRequest } from "./model-request.entity.functions.js"
import { ModelRequestHeader } from "./model-request.entity.js"
import type { MemoryRenderRecipe } from "./model-request.entity.js"
import { UserMessage } from "./user-message.entity.js"

const session = ConversationId.make("00000000-0000-4000-8000-00000000a7a7")

const header = (runId: Schema.Json, step: Schema.Json, system: Schema.Json): JsonObject => ({
  version: 1, runId, step, strategyVersion: "window@1", system,
  render: { strategy: "window", currentTurn: 1, currentRun: "run-1", turnContext: "current", replies: true, stepContext: "tail", digests: true, media: { mode: "none", maxImages: 8 } },
  through: null, contextFingerprint: "f", tools: [], toolChoice: "auto", model: null, cacheKey: null, callPolicy: null,
})

const prepared = (seq: number, data: JsonObject): SessionLogEvent => ({ session, seq, turn: Option.some(1), kind: "request.prepared", at: 0, data })

/** The header found for step 0 of run-1's run `run` (its first by default), or the code it failed with. */
const found = (events: ReadonlyArray<SessionLogEvent>, run = 0) => Effect.runPromise(modelRequestHeaderOf(events, RunId.make("run-1"), 0, RunOrdinal.make(run)).pipe(
  Effect.match({ onFailure: (error) => error.code, onSuccess: (decoded) => decoded.system }),
))

describe("a request's stored header, found by its run and step", () => {
  test("each run of a turn finds its own header for a step; one stored before runs were counted is the first run's", async () => {
    const runs = [
      prepared(1, header("run-1", 0, "before runs were counted")),
      prepared(2, { ...header("run-1", 0, "second run"), run: 1 }),
    ]
    expect([await found(runs, 0), await found(runs, 1), await found(runs, 2)]).toEqual(["before runs were counted", "second run", "request.missing"])
    expect(await found([...runs, prepared(3, { ...header("run-1", 0, "first run"), run: 0 })], 0)).toBe("first run")
  })

  test("the last header of the run and step is decoded; one of another run or step is not", async () => {
    expect(await found([
      prepared(1, header("run-1", 0, "first")),
      prepared(2, header("run-2", 0, "other run")),
      prepared(3, header("run-1", 0, "retried")),
      prepared(4, header("run-1", 1, "next step")),
    ])).toBe("retried")
    expect(await found([prepared(1, header("run-2", 0, "other run"))])).toBe("request.missing")
  })

  test("a header whose run or step does not decode fails with request.decode, never reads as missing", async () => {
    expect(await found([prepared(1, header(7, 0, "system"))])).toBe("request.decode")
    expect(await found([prepared(1, header("run-1", "0", "system"))])).toBe("request.decode")
  })

  test("only the header found is decoded whole", async () => {
    expect(await found([prepared(1, header("run-2", 0, 42)), prepared(2, header("run-1", 0, "system"))])).toBe("system")
    expect(await found([prepared(1, header("run-1", 0, 42))])).toBe("request.decode")
  })
})

const requestRun = RunId.make("request-run")
const requestOrdinal = RunOrdinal.make(0)
const recipe: MemoryRenderRecipe = {
  strategy: "window", currentTurn: 1, currentRun: requestRun, run: requestOrdinal,
  turnContext: "current", replies: true, stepContext: "tail", digests: true,
  media: { mode: "none", maxImages: 8, maxChars: 20_000_000 },
}
const requestEntries: ReadonlyArray<LogEntry> = [
  { id: entryId(requestRun, 0), runId: requestRun, turn: 1, step: 0, at: 0, body: { _tag: "TurnStarted", userMessage: new UserMessage({ text: "history" }) } },
  { id: entryId(requestRun, 1), runId: requestRun, turn: 1, step: 0, at: 0, body: {
    _tag: "Message", run: requestOrdinal, message: { role: "assistant", content: [
      { type: "reasoning", text: "signed reasoning", providerOptions: { custom: { signature: "α\nexact-signature", redacted: "opaque==" } } },
      { type: "text", text: "stable answer" },
    ] },
  } },
  { id: entryId(requestRun, 2), runId: requestRun, turn: 1, step: 1, at: 0, body: { _tag: "StepContext", run: requestOrdinal, step: 1, text: "volatile tail" } },
]
const savedRequest = (stableMessages?: number): ModelRequestHeader => {
  const built = buildContext(requestEntries, recipe)
  return {
    version: 1, runId: requestRun, run: requestOrdinal, step: 1, strategyVersion: "1", system: "system",
    render: recipe, through: built.through, contextFingerprint: built.fingerprint,
    ...(stableMessages === undefined ? {} : { stableMessages }),
    tools: [], toolChoice: "auto", model: Option.none(), cacheKey: Option.none(), callPolicy: Option.none(),
  }
}

describe("a request's frozen stable prefix", () => {
  test("optional historical headers remain unmarked; current headers retain the exact count through the codec", async () => {
    const built = buildContext(requestEntries, recipe)
    const old = savedRequest()
    const current = savedRequest(built.stableMessages)
    const roundTrip = Schema.decodeUnknownSync(ModelRequestHeader)(Schema.encodeSync(ModelRequestHeader)(current))
    expect(roundTrip.stableMessages).toBe(2)
    expect("stableMessages" in Schema.encodeSync(ModelRequestHeader)(old)).toBe(false)
    const [legacy, marked] = await Effect.runPromise(Effect.all([
      reconstructModelRequest(old, requestEntries), reconstructModelRequest(roundTrip, requestEntries),
    ], { concurrency: 1 }))
    expect(legacy.prompt.content.map((message) => isVolatileContext(message.options))).toEqual([false, false, false, false])
    expect(marked.prompt.content.map((message) => isVolatileContext(message.options))).toEqual([false, false, false, true])
    expect(marked.contextFingerprint).toBe(legacy.contextFingerprint)
    expect(canonicalJson(marked.prompt)).toContain("α\\nexact-signature")
    expect(canonicalJson(requestEntries)).not.toContain("requestVolatile")
  })

  test.each([0, 1, 3])("reconstructs the frozen prefix %i instead of recomputing its classification", async (stableMessages) => {
    const request = await Effect.runPromise(reconstructModelRequest(savedRequest(stableMessages), requestEntries))
    expect(request.prompt.content.map((message) => isVolatileContext(message.options))).toEqual([false, ...[0, 1, 2].map((index) => index === stableMessages)])
    expect(request.contextFingerprint).toBe(savedRequest().contextFingerprint)
  })

  test("rejects a frozen count beyond the rebuilt messages and malformed stored counts", async () => {
    const failed = await Effect.runPromise(Effect.result(reconstructModelRequest(savedRequest(4), requestEntries)))
    expect(failed._tag === "Failure" ? [failed.failure.code, failed.failure.message.split(":")[0]] : "passed").toEqual(["request.diverged", "context"])
    const encoded = Schema.encodeSync(ModelRequestHeader)(savedRequest(0))
    expect([-1, 0.5, "2", null].map((stableMessages) => Option.isSome(Schema.decodeUnknownOption(ModelRequestHeader)({ ...encoded, stableMessages })))).toEqual([false, false, false, false])
    expect([0, 3].map((stableMessages) => Option.isSome(Schema.decodeUnknownOption(ModelRequestHeader)({ ...encoded, stableMessages })))).toEqual([true, true])
    expect(encoded.stableMessages).toBe(0)
  })

  test("a marker-only dispatch change fails the exact messages check", async () => {
    const expected = await Effect.runPromise(reconstructModelRequest(savedRequest(2), requestEntries))
    const unmarked = await Effect.runPromise(reconstructModelRequest(savedRequest(), requestEntries))
    const alteredBoundary = await Effect.runPromise(reconstructModelRequest(savedRequest(1), requestEntries))
    const results = await Effect.runPromise(Effect.forEach([unmarked, alteredBoundary], (actual) => Effect.result(checkModelRequest(expected, actual)), { concurrency: 1 }))
    expect(results.map((result) => result._tag === "Failure" ? [result.failure.code, result.failure.message.split(":")[0]] : "passed")).toEqual([["request.diverged", "messages"], ["request.diverged", "messages"]])
    expect(await Effect.runPromise(Effect.result(checkModelRequest(expected, { ...expected, prompt: Prompt.make(expected.prompt) })))).toMatchObject({ _tag: "Success" })
  })

  test("later compaction and step-context writes cannot move the saved cut or marker", async () => {
    const header = savedRequest(2)
    const later: ReadonlyArray<LogEntry> = [
      ...requestEntries,
      { id: entryId(requestRun, 3), runId: requestRun, turn: 1, step: 2, at: 0, body: { _tag: "Compaction", strategy: "window", version: "1", action: { _tag: "DropTurns", throughTurn: 1, ledger: "later condensed history" } } },
      { id: entryId(requestRun, 4), runId: requestRun, turn: 1, step: 2, at: 0, body: { _tag: "StepContext", run: requestOrdinal, step: 2, text: "later tail" } },
    ]
    const original = await Effect.runPromise(reconstructModelRequest(header, requestEntries))
    expect(await Effect.runPromise(reconstructModelRequest(header, later))).toEqual(original)
    const changed = requestEntries.map((entry) => entry.body._tag === "Message"
      ? { ...entry, body: { ...entry.body, message: { role: "assistant" as const, content: [{ type: "text" as const, text: "changed signed history" }] } } }
      : entry)
    const failed = await Effect.runPromise(Effect.result(reconstructModelRequest(header, changed)))
    expect(failed._tag === "Failure" ? [failed.failure.code, failed.failure.message.split(":")[0]] : "passed").toEqual(["request.diverged", "context"])
  })
})
