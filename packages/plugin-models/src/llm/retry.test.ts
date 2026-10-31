import { describe, expect, test } from "bun:test"
import { AiError } from "effect/ai"
import { HttpClientError, HttpClientRequest } from "effect/http"
import { Effect, Option, Stream } from "effect"
import { CurrentEmptyResponseTolerance, modelFailureOf } from "@xandreed/core"
import { classifyLlmError, rejectEmptyResponse, rejectEmptyStream } from "./retry.js"

const request = { method: "POST" as const, url: "https://gw.example/chat", urlParams: [], headers: {} }
/** A provider status failure, as the adapters build it. */
const httpError = (status: number, headers: Record<string, string> = {}) =>
  AiError.make({
    module: "Test",
    method: "generateText",
    reason: AiError.reasonFromHttpStatus({ status, http: { request, response: { status, headers } } }),
  })
const reasonError = (reason: AiError.AiErrorReason) => AiError.make({ module: "Test", method: "generateText", reason })
/** Classified now, on the wall clock. */
const classify = (error: unknown) => classifyLlmError(error, 0)

describe("classifyLlmError", () => {
  test("429 and 5xx are transient; other 4xx permanent", () => {
    const http = (status: number) => httpError(status)
    expect(classify(http(429))).toBe("transient")
    expect(classify(http(500))).toBe("transient")
    expect(classify(http(503))).toBe("transient")
    expect(classify(http(400))).toBe("permanent")
    expect(classify(http(401))).toBe("permanent")
    expect(classify(http(404))).toBe("permanent")
  })

  test("transport/timeout (UnknownError) is transient; decode failures permanent", () => {
    expect(classify(reasonError(new AiError.UnknownError({ description: "socket hang up" })))).toBe("transient")
    // Effect's own providers report transport failures as NetworkError.
    expect(classify(reasonError(new AiError.NetworkError({ reason: "TransportError", request, description: "reset" })))).toBe("transient")
    expect(classify(reasonError(new AiError.InvalidOutputError({ description: "not JSON" })))).toBe("permanent")
    expect(classify("boom")).toBe("permanent")
  })

  test("a raw HTTP client's transport failure (the subscription socket's) is transient; its other failures, or a look-alike, permanent", () => {
    const socketRequest = HttpClientRequest.post("https://chatgpt.example/backend-api/codex/responses")
    const failure = (reason: HttpClientError.HttpClientErrorReason) => new HttpClientError.HttpClientError({ reason })
    expect(classify(failure(new HttpClientError.TransportError({ request: socketRequest, description: "socket closed" })))).toBe("transient")
    expect(classify(failure(new HttpClientError.EncodeError({ request: socketRequest, description: "not JSON" })))).toBe("permanent")
    expect(classify({ _tag: "HttpClientError", reason: { _tag: "TransportError" } })).toBe("permanent")
  })

  test("a long Retry-After remains rate limiting; the request policy owns capped sleeps", () => {
    expect(classify(httpError(429, { "retry-after": "3600" }))).toBe("transient")
    expect(classify(httpError(429, { "retry-after": "Thu, 01 Jan 2099 00:00:00 GMT" }))).toBe("transient")
  })

  test("an exhausted quota is permanent whatever status carried it", () => {
    expect(classify(reasonError(new AiError.QuotaExhaustedError({})))).toBe("permanent")
    expect(classify(reasonError(new AiError.QuotaExhaustedError({ http: { request, response: { status: 429, headers: {} } } })))).toBe("permanent")
  })
})

describe("empty response guards after HTTP handoff", () => {
  const finish = { type: "finish", reason: "stop" }
  test("an empty settled response fails once while real content keeps its identity", async () => {
    const failed = await Effect.runPromise(Effect.flip(rejectEmptyResponse("fixture")(Effect.succeed({ content: [finish] }))))
    expect(modelFailureOf(failed)).toEqual(Option.some("Transient"))
    const response = { content: [{ type: "text", text: "answer" }, finish] }
    expect(await Effect.runPromise(rejectEmptyResponse("fixture")(Effect.succeed(response)))).toBe(response)
  })
  test("a post-tool empty finish is accepted under the loop's tolerance, settled and streamed", async () => {
    const observed = await Effect.runPromise(Effect.all([
      rejectEmptyResponse("fixture")(Effect.succeed({ content: [finish] })),
      Stream.runCollect(rejectEmptyStream("fixture")(Stream.succeed(finish))),
    ], { concurrency: 1 }).pipe(Effect.provideService(CurrentEmptyResponseTolerance, true)))
    expect(observed).toEqual([{ content: [finish] }, [finish]])
  })
  test("signed and redacted reasoning count as streamed content without text", async () => {
    const signature = { type: "reasoning-delta", id: "0", delta: "", metadata: { vendor: { signature: "sig" } } }
    const redacted = { type: "reasoning-start", id: "1", metadata: { vendor: { redacted: "data" } } }
    expect(await Effect.runPromise(Effect.all([signature, redacted].map((part) => Stream.runCollect(rejectEmptyStream("fixture")(Stream.fromIterable([part, finish])))), { concurrency: 1 }))).toEqual([[signature, finish], [redacted, finish]])
    const bare = { type: "reasoning-start", id: "2", metadata: {} }
    const failed = await Effect.runPromise(Effect.flip(Stream.runCollect(rejectEmptyStream("fixture")(Stream.fromIterable([bare, finish])))))
    expect(modelFailureOf(failed)).toEqual(Option.some("Transient"))
  })
  test("stream errors retain identity and never resubscribe", async () => {
    const failure = reasonError(new AiError.InternalProviderError({ description: "stream failed" }))
    const attempts: Array<number> = []
    const stream = Stream.unwrap(Effect.sync(() => {
      attempts.push(1)
      return Stream.succeed({ type: "text-delta", id: "0", delta: "partial" }).pipe(Stream.concat(Stream.fail(failure)))
    }))
    expect(await Effect.runPromise(Effect.flip(Stream.runCollect(rejectEmptyStream("fixture")(stream))))).toBe(failure)
    expect(attempts).toHaveLength(1)
  })
})
