import { describe, expect, test } from "bun:test"
import { AiError } from "effect/ai"
import { Effect, Fiber, Option, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { ENGINE_KEY, ModelFailureKind, modelFailureOf, stampAiErrorFailure } from "@xandreed/core"
import { makeCompatLanguageModel } from "./compat.js"
import { mapOpenAiCodexError } from "./openAiCodex.js"
import { classifyLlmError, makeCallBudget, rejectEmptyResponse, retryableLlm, retryableLlmStream } from "./retry.js"
import { classifyAiError } from "./provider-failure.entity.functions.js"

const encodedError = { error: { type: "invalid_request_error", code: "context_length_exceeded", message: "fixture context refusal" } }
const request = { method: "POST" as const, url: "https://fixture.invalid/responses", urlParams: [], headers: {} }
const sdkError = (status: number, body: unknown) => AiError.make({ module: "OpenAiClient", method: "createResponseStream", reason: new AiError.UnknownError({ http: { request, response: { status, headers: { "x-request-id": "fixture-request" } }, body: JSON.stringify(body) } }) })

describe("provider failures survive existing adapter boundaries", () => {
  test("compat text, object and stream HTTP errors retain context identity and HTTP evidence", async () => {
    const calls: Array<string> = []
    const results = await Effect.runPromise(Effect.forEach(["text", "object", "stream"] as const, (mode) => Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ moduleName: "Fixture", model: "fixture", chatUrl: "https://fixture.invalid/chat/completions", fetchImpl: () => {
        calls.push(mode)
        return Promise.resolve(Response.json(encodedError, { status: 400, headers: { "x-request-id": "fixture-request" } }))
      } })
      const call = mode === "stream" ? Stream.runDrain(model.streamText({ prompt: "fixture" }))
        : mode === "object" ? model.generateObject({ prompt: "fixture", schema: Schema.Struct({ ok: Schema.Boolean }) }).pipe(Effect.asVoid)
          : model.generateText({ prompt: "fixture" }).pipe(Effect.asVoid)
      return yield* Effect.flip(call)
    }), { concurrency: 1 }))
    expect(calls).toEqual(["text", "object", "stream"])
    results.forEach((error) => {
      expect(modelFailureOf(error)).toEqual(Option.some("ContextOverflow"))
      if (!("http" in error.reason)) return
      expect(error.reason.http?.response?.status).toBe(400)
      expect(error.reason.http?.body).toBe(JSON.stringify(encodedError))
      expect(error.reason.http?.response?.headers["x-request-id"]).toBe("fixture-request")
    })
  })

  test("compat raw SSE error codes remain typed after visible content without a second request", async () => {
    const calls: Array<number> = []
    const seen: Array<unknown> = []
    const chunks = [new TextEncoder().encode('data: {"choices":[{"delta":{"content":"visible"}}]}\n\n'), new TextEncoder().encode(`data: ${JSON.stringify(encodedError)}\n\n`)]
    const failed = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ moduleName: "Fixture", model: "fixture", chatUrl: "https://fixture.invalid/chat/completions", fetchImpl: () => {
        calls.push(1)
        return Promise.resolve(new Response(new ReadableStream({ pull(controller) {
          const next = chunks.shift()
          if (next === undefined) controller.close()
          else controller.enqueue(next)
        } }), { headers: { "content-type": "text/event-stream" } }))
      } })
      return yield* Effect.flip(Stream.runDrain(model.streamText({ prompt: "fixture" }).pipe(Stream.tap((part) => Effect.sync(() => seen.push(part))))))
    }))
    expect(modelFailureOf(failed)).toEqual(Option.some("ContextOverflow"))
    expect(calls).toEqual([1])
    expect(seen).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "visible" }))
  })

  test("Codex classifies raw context codes before its 200/protocol rewrite and preserves declared evidence", () => {
    ;[200, 400].forEach((status) => {
      const original = sdkError(status, encodedError)
      const classified = mapOpenAiCodexError("fixture", original)
      expect(modelFailureOf(classified)).toEqual(Option.some("ContextOverflow"))
      expect(classified.reason._tag).toBe("UnknownError")
      if (!("http" in classified.reason) || !("http" in original.reason)) return
      expect(classified.reason.http).toEqual(original.reason.http)
    })
    const original = stampAiErrorFailure(sdkError(200, {}), "Authentication")
    expect(mapOpenAiCodexError("fixture", original)).toBe(original)
    ModelFailureKind.literals.forEach((kind) => {
      const explicit = stampAiErrorFailure(sdkError(200, { evidence: "retained" }), kind)
      expect(mapOpenAiCodexError("fixture", explicit)).toBe(explicit)
    })
    expect(modelFailureOf(mapOpenAiCodexError("fixture", sdkError(200, {})))).toEqual(Option.some("InvalidResponse"))
  })

  test("semantic permanent stamps override old Unknown retry heuristics, while unknown/rate timing stays unchanged", () => {
    const original = AiError.make({ module: "Fixture", method: "call", reason: new AiError.UnknownError({ description: "fixture" }) })
    ;["ContextOverflow", "Authentication", "InvalidRequest", "Quota", "InvalidResponse"].forEach((kind) => {
      const error = AiError.make({ module: "Fixture", method: "call", reason: new AiError.UnknownError({ metadata: { [ENGINE_KEY]: { failure: kind } } }) })
      expect(classifyLlmError(error, 0)).toBe("permanent")
    })
    expect(classifyLlmError(original, 0)).toBe("transient")
    expect(classifyLlmError(stampAiErrorFailure(original, "Timeout"), 0)).toBe("transient")
    const limited = AiError.make({ module: "Fixture", method: "call", reason: new AiError.RateLimitError({ http: { request, response: { status: 429, headers: { "retry-after": "120" } } } }) })
    expect(modelFailureOf(limited)).toEqual(Option.some("RateLimit"))
    expect(classifyLlmError(limited, 0)).toBe("permanent")
  })

  test("structured permanent refusals win over misleading statuses through the actual compat adapter and retry guard", async () => {
    const cases = [
      { status: 413, error: { type: "request_too_large", message: "prompt is too long" }, expected: "InvalidRequest" },
      { status: 429, error: { type: "invalid_request_error", message: "invalid tool schema" }, expected: "InvalidRequest" },
      { status: 402, error: { code: "invalid_api_key", message: "key refused" }, expected: "Authentication" },
    ] as const
    const observed = await Effect.runPromise(Effect.forEach(cases, (sample) => Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ moduleName: "Fixture", model: "fixture", chatUrl: "https://fixture.invalid/chat/completions", fetchImpl: () => Promise.resolve(Response.json({ error: sample.error }, { status: sample.status })) })
      const failed = yield* Effect.flip(model.generateText({ prompt: "fixture" }))
      return { kind: modelFailureOf(failed), retry: classifyLlmError(failed, 0) }
    }), { concurrency: 1 }))
    expect([...observed]).toEqual(cases.map((sample) => ({ kind: Option.some(sample.expected), retry: "permanent" as const })))
    const limited = AiError.make({ module: "Fixture", method: "call", reason: new AiError.RateLimitError({ http: { request, response: { status: 429, headers: {} }, body: '{"error":{"type":"invalid_request_error","message":"invalid tool schema"}}' } }) })
    const classified = classifyAiError(limited, "compat")
    expect(modelFailureOf(classified)).toEqual(Option.some("InvalidRequest"))
    expect(classifyLlmError(classified, 0)).toBe("permanent")
    expect(classified.reason._tag).toBe("RateLimitError")
  })

  test("the empty guard retains explicitly failed responses and stamps its own genuinely empty error", async () => {
    const response = { content: [{ type: "finish", metadata: { [ENGINE_KEY]: { failure: "ContextOverflow" } } }] }
    expect(await Effect.runPromise(rejectEmptyResponse("fixture")(Effect.succeed(response)))).toBe(response)
    const empty = await Effect.runPromise(Effect.flip(rejectEmptyResponse("fixture")(Effect.succeed({ content: [] }))))
    expect(modelFailureOf(empty)).toEqual(Option.some("Transient"))
  })

  test("the stream empty guard retains a stamped failure finish instead of replacing its meaning", async () => {
    const parts = [{ type: "finish", metadata: { [ENGINE_KEY]: { failure: "ContextOverflow" } } }]
    const result = await Effect.runPromise(Stream.runCollect(retryableLlmStream("fixture")(Stream.fromIterable(parts))).pipe(Effect.timeout("1 second")))
    expect(result).toEqual(parts)
  })

  test("the existing total call-budget error carries Timeout without changing its deadline", async () => {
    const timed = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.gen(function* () {
        const budget = yield* makeCallBudget(10)
        return yield* Effect.flip(retryableLlm("fixture", budget)(Effect.never))
      }))
      yield* TestClock.adjust("1 second")
      return yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer())))
    expect(modelFailureOf(timed)).toEqual(Option.some("Timeout"))
    expect(timed.message).toContain("0.01s budget")
  })
})
