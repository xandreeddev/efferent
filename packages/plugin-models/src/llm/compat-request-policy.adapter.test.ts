import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Stream } from "effect"
import { AiError } from "effect/ai"
import { FetchHttpClient } from "effect/http"
import { modelFailureOf, stampAiErrorFailure } from "@xandreed/core"
import { CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import type { ModelRetryPolicy } from "./model-retry-policy.entity.js"
import { makeCompatLanguageModel } from "./compat.js"
import { sseStreamParts } from "./sse.js"

const policy: ModelRetryPolicy = {
  maxAttempts: 3, requestTimeoutMs: 100, bodyIdleTimeoutMs: 25,
  totalTimeoutMs: 250, retryAfterMaxMs: 0,
  backoff: { initialMs: 0, maxMs: 0, jitter: 0 },
}
const config = { moduleName: "Fixture", model: "fixture", chatUrl: "https://models.invalid/chat/completions" }
const completed = () => Object.defineProperty(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "finished" } }] }), {
  statusText: "Fixture Ready", headers: { "content-type": "application/json", "x-fixture": "retained" },
}), "url", { value: "https://models.invalid/finished" })

describe("compatible request policy", () => {
  test("one transport/status counter preserves public hooks and buffered response metadata", async () => {
    const attempts: string[] = []
    const hooks: string[] = []
    const result = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({
        ...config,
        fetchImpl: (_input, init) => {
          attempts.push(String(init?.body))
          if (attempts.length === 1) return Promise.reject(new TypeError("fixture connection reset"))
          return Promise.resolve(attempts.length === 2 ? new Response("temporarily unavailable", { status: 503 }) : completed())
        },
        beforeRequest: () => Effect.sync(() => { hooks.push("before") }),
        aroundRequest: (_body, request) => request.pipe(Effect.tap((response) => Effect.tryPromise(async () => {
          hooks.push(`around:${response.status}:${response.statusText}:${response.headers.get("x-fixture")}`)
          expect(response.url).toBe("https://models.invalid/finished")
          expect(await response.clone().text()).toContain("finished")
        }).pipe(Effect.mapError((error) => AiError.make({ module: "Fixture", method: "hook", reason: new AiError.UnknownError({ description: String(error) }) }))))),
      })
      return yield* model.generateText({ prompt: "hello" })
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(result.text).toBe("finished")
    expect(attempts).toHaveLength(3)
    expect(new Set(attempts).size).toBe(1)
    expect(hooks).toEqual(["before", "around:200:Fixture Ready:retained"])
  })

  test("uses the explicit call-local Fetch reference when no fetchImpl is configured", async () => {
    const calls: string[] = []
    const result = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel(config)
      return yield* model.generateText({ prompt: "hello" })
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, Object.assign(async (input: string | URL | Request) => {
      calls.push(String(input))
      return completed()
    }, { preconnect: () => undefined }))))
    expect(result.text).toBe("finished")
    expect(calls).toEqual([config.chatUrl])
  })

  test("a late canceled attempt cannot overwrite the successful response metadata", async () => {
    const headers: string[] = []
    const signals: Array<AbortSignal | null | undefined> = []
    const first: Array<(response: Response) => void> = []
    const body: Array<ReadableStreamDefaultController<Uint8Array>> = []
    const text = await Effect.runPromise(Effect.gen(function* () {
      const reading = yield* Deferred.make<void>()
      const model = yield* makeCompatLanguageModel({
        ...config,
        fetchImpl: (_input, init) => {
          signals.push(init?.signal)
          if (signals.length === 1) return new Promise<Response>((resolve) => { first.push(resolve) })
          return Promise.resolve(new Response(new ReadableStream<Uint8Array>({
            pull(controller) {
              body.push(controller)
              Deferred.doneUnsafe(reading, Effect.void)
            },
          }, { highWaterMark: 0 }), { statusText: "Final second attempt", headers: { "x-fixture": "second" } }))
        },
        aroundRequest: (_request, response) => response.pipe(Effect.tap((value) => Effect.sync(() => {
          headers.push(`${value.statusText}:${value.headers.get("x-fixture")}`)
        }))),
      })
      const running = yield* Effect.forkChild(model.generateText({ prompt: "hello" }))
      // The second body is being read, so its headers and metadata arrived.
      yield* Deferred.await(reading)
      expect(signals[0]?.aborted).toBe(true)
      first[0]!(new Response("discarded", { status: 503, statusText: "Stale first attempt" }))
      // Let the ignored first promise settle before completing the second body.
      yield* Effect.tryPromise(() => Promise.resolve())
      body[0]!.enqueue(new TextEncoder().encode(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "finished" } }] })))
      body[0]!.close()
      return (yield* Fiber.join(running)).text
    }).pipe(
      Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts: 2, requestTimeoutMs: 25, bodyIdleTimeoutMs: 500, totalTimeoutMs: 1000 }),
      Effect.timeout("2 seconds"),
    ))
    expect(text).toBe("finished")
    expect(signals).toHaveLength(2)
    expect(headers).toEqual(["Final second attempt:second"])
  })

  test("bounds pending fetch headers and aborts the actual request", async () => {
    const aborted: number[] = []
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({
        ...config, fetchImpl: (_input, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { aborted.push(1); reject(new Error("fixture abort")) }, { once: true })
        }),
      })
      return yield* model.generateText({ prompt: "hello" }).pipe(Effect.exit)
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts: 1, requestTimeoutMs: 25 }), Effect.timeoutOption("500 millis")))
    expect(Option.isSome(outcome)).toBe(true)
    if (Option.isSome(outcome) && Exit.isFailure(outcome.value)) expect(modelFailureOf(Cause.squash(outcome.value.cause))).toEqual(Option.some("Timeout"))
    expect(aborted).toEqual([1])
  })

  Array.of(false, true).forEach((streaming) => test(`${streaming ? "SSE" : "settled"} body idle timeout remains typed and never retries a handed-off response`, async () => {
    const calls: number[] = []
    const aborted: number[] = []
    const cancelled: number[] = []
    const outcome = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({
        ...config,
        fetchImpl: async (_input, init) => {
          calls.push(1)
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) {
              init?.signal?.addEventListener("abort", () => { aborted.push(1); controller.error(new Error("fixture abort")) }, { once: true })
            },
            cancel() { cancelled.push(1) },
          }), { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } })
        },
      })
      return yield* (streaming ? Stream.runDrain(model.streamText({ prompt: "hello" })) : model.generateText({ prompt: "hello" }).pipe(Effect.asVoid)).pipe(Effect.exit)
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy), Effect.timeoutOption("500 millis")))
    expect(Option.isSome(outcome)).toBe(true)
    if (Option.isSome(outcome)) {
      expect(Exit.isFailure(outcome.value)).toBe(true)
      if (Exit.isFailure(outcome.value)) expect(modelFailureOf(Cause.squash(outcome.value.cause))).toEqual(Option.some("Timeout"))
    }
    expect(calls).toHaveLength(1)
    expect(aborted.length + cancelled.length).toBeGreaterThan(0)
  }))

  test("malformed successful JSON is final after one request", async () => {
    const calls: number[] = []
    const failure = await Effect.runPromise(Effect.gen(function* () {
      const model = yield* makeCompatLanguageModel({ ...config, fetchImpl: async () => { calls.push(1); return new Response("not JSON") } })
      return yield* model.generateText({ prompt: "hello" }).pipe(Effect.exit)
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(Exit.isFailure(failure)).toBe(true)
    expect(calls).toHaveLength(1)
  })

  test("SSE keeps an existing typed body failure by identity", async () => {
    const expected = stampAiErrorFailure(AiError.make({ module: "Fixture", method: "body", reason: new AiError.UnknownError({ description: "fixture timeout" }) }), "Timeout")
    const exit = await Effect.runPromise(Stream.runCollect(sseStreamParts({
      moduleName: "Fixture", body: new ReadableStream({ start(controller) { controller.error(expected) } }),
    })).pipe(Effect.exit))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(expected)
  })
})
