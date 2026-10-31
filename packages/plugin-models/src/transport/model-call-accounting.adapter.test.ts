import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Option, Ref } from "effect"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { CurrentModelCallRecorder, harnessError } from "@xandreed/core"
import type { ModelCallData } from "@xandreed/core"
import { modelRetryDefaults } from "../llm/model-retry-policy.entity.js"
import { CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import { completeModelAttempt, modelAttemptOf, observeModelAttempt } from "../llm/model-completion.adapter.js"
import { resilientRequest } from "./resilient-http-client.adapter.js"

const policy = { ...modelRetryDefaults, requestTimeoutMs: 1000, bodyIdleTimeoutMs: 1000, totalTimeoutMs: 3000, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }
const request = HttpClientRequest.post("https://fixture.invalid/messages").pipe(HttpClientRequest.bodyJsonUnsafe({ fixture: true }))

describe("physical model attempt accounting", () => {
  test("failed attempts are acknowledged before another send and the final decoder joins one identity", async () => {
    const records: Array<ModelCallData> = []
    const order: Array<string> = []
    const client = HttpClient.make((request) => Effect.suspend(() => {
      order.push(`send:${order.filter(value => value.startsWith("send:")).length + 1}`)
      const ordinal = order.filter(value => value.startsWith("send:")).length
      return ordinal === 1 ? Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request }) }))
        : Effect.succeed(HttpClientResponse.fromWeb(request, ordinal === 2 ? new Response("busy", { status: 429 }) : new Response("ok")))
    }))
    const result = await Effect.runPromise(Effect.gen(function* () {
      const response = yield* resilientRequest(client, request, { protocol: "compat" })
      const attempt = modelAttemptOf(response)
      expect(Option.isSome(attempt)).toBe(true)
      if (Option.isSome(attempt)) {
        yield* observeModelAttempt(attempt.value, { prompt_tokens: 5, completion_tokens: 3 }, true)
        yield* completeModelAttempt(attempt.value, { _tag: "Completed" })
        yield* completeModelAttempt(attempt.value, { _tag: "Completed" })
      }
      return yield* response.text
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy), Effect.provideService(CurrentModelCallRecorder, { record: data => Effect.sync(() => { records.push(data); order.push(`record:${data.attempt}`) }) })))
    expect(result).toBe("ok")
    expect(order).toEqual(["send:1", "record:1", "send:2", "record:2", "send:3", "record:3"])
    expect(new Set(records.map(data => data.callId)).size).toBe(1)
    expect(records.map(data => [data.attempt, data.usage._tag, data.outcome._tag])).toEqual([[1, "Unknown", "Failed"], [2, "Unknown", "Failed"], [3, "Known", "Completed"]])
  })
  test("a failed recorder prevents the next send and preserves the original TurnError", async () => {
    const expected = harnessError("session.log", "fixture recorder failed")
    const sends: Array<number> = []
    const client = HttpClient.make(request => Effect.sync(() => { sends.push(1); return HttpClientResponse.fromWeb(request, new Response("busy", { status: 503 })) }))
    const failure = await Effect.runPromise(Effect.flip(resilientRequest(client, request, { protocol: "compat" })).pipe(
      Effect.provideService(CurrentModelRetryPolicy, policy), Effect.provideService(CurrentModelCallRecorder, { record: () => Effect.fail(expected) }),
    ))
    expect(failure).toBe(expected)
    expect(sends).toEqual([1])
  })
  test("a rejected body can retain reported final usage before its attempt is discarded", async () => {
    const records: Array<ModelCallData> = []
    const sends: Array<number> = []
    const client = HttpClient.make(request => Effect.sync(() => {
      sends.push(1)
      return HttpClientResponse.fromWeb(request, sends.length === 1
        ? Response.json({ error: { type: "overloaded_error" }, usage: { prompt_tokens: 7, completion_tokens: 1 } }, { status: 503 }) : new Response("ok"))
    }))
    await Effect.runPromise(resilientRequest(client, request, { protocol: "compat" }).pipe(
      Effect.flatMap(response => response.text), Effect.provideService(CurrentModelRetryPolicy, policy),
      Effect.provideService(CurrentModelCallRecorder, { record: data => Effect.sync(() => { records.push(data) }) }),
    ))
    expect(sends).toEqual([1, 1])
    expect(records.map(data => [data.attempt, data.usage._tag, data.outcome._tag])).toEqual([[1, "Known", "Failed"]])
    expect(records[0]?.usage).toEqual({ _tag: "Known", usage: { inputTokens: 7, outputTokens: 1, totalTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
  })
  test("interruption while headers are pending records one Interrupted attempt", async () => {
    const records: Array<ModelCallData> = []
    await Effect.runPromise(Effect.gen(function* () {
      const sent = yield* Deferred.make<void>()
      const client = HttpClient.make(() => Deferred.succeed(sent, undefined).pipe(Effect.andThen(Effect.never)))
      const fiber = yield* Effect.forkChild(resilientRequest(client, request, { protocol: "compat" }))
      yield* Deferred.await(sent)
      yield* Fiber.interrupt(fiber)
      expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true)
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy), Effect.provideService(CurrentModelCallRecorder, { record: data => Effect.sync(() => { records.push(data) }) }), Effect.timeout("2 seconds")))
    expect(records.map(data => [data.attempt, data.usage._tag, data.outcome._tag])).toEqual([[1, "Unknown", "Interrupted"]])
  })
})
