import { describe, expect, test } from "bun:test"
import { Clock, Deferred, Effect, Exit, Fiber, Option, Ref, Stream } from "effect"
import { AiError } from "effect/ai"
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"
import { ConversationId, TurnClosed, harnessError, modelFailureOf } from "@xandreed/core"
import { modelRetryDefaults } from "../llm/model-retry-policy.entity.js"
import { CurrentModelRequestCall, CurrentModelRetryPolicy } from "../ports/model-retry-policy.port.js"
import { enterModelFallback, makeModelRequestCall, modelRequestSnapshot, resilientRequest } from "./resilient-http-client.adapter.js"

const policy = { ...modelRetryDefaults, requestTimeoutMs: 50, bodyIdleTimeoutMs: 50, totalTimeoutMs: 2000, backoff: { initialMs: 0, maxMs: 0, jitter: 0 } }
const request = HttpClientRequest.post("https://fixture.invalid/messages").pipe(HttpClientRequest.bodyJsonUnsafe({ fixture: true }))
type Reply = "transport" | { readonly status: number; readonly body: string; readonly headers?: Readonly<Record<string, string>> }
const scripted = (replies: ReadonlyArray<Reply>) => {
  const sends: Array<number> = []
  const client = HttpClient.make((request) => Effect.suspend(() => {
    const ordinal = sends.length
    sends.push(ordinal + 1)
    const reply = replies[ordinal] ?? { status: 200, body: "ok" }
    return reply === "transport"
      ? Effect.fail(new HttpClientError.HttpClientError({ reason: new HttpClientError.TransportError({ request, description: "fixture transport failure" }) }))
      : Effect.succeed(HttpClientResponse.fromWeb(request, new Response(reply.body, { status: reply.status, ...(reply.headers === undefined ? {} : { headers: reply.headers }) })))
  }))
  return { sends, client }
}
const rejected = (status: number, type = "overloaded_error", message = "fixture") => ({ status, body: JSON.stringify({ error: { type, message } }) })
const inClock = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.gen(function* () {
  const fiber = yield* Effect.forkChild(effect)
  yield* TestClock.adjust("1 second")
  return yield* Fiber.join(fiber)
}).pipe(Effect.provide(TestClock.layer()), Effect.timeout("2 seconds")))

describe("bounded model HTTP requests", () => {
  test("mixed transport and status failures use one counter before a readable success", async () => {
    const raw = scripted(["transport", rejected(429, "rate_limit_error"), rejected(529), { status: 200, body: "ok" }])
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const call = yield* makeModelRequestCall({ reserveFallback: false })
      const response = yield* resilientRequest(raw.client, request, { protocol: "anthropic" }).pipe(Effect.provideService(CurrentModelRequestCall, Option.some(call)))
      return { text: yield* response.text, state: yield* modelRequestSnapshot(call) }
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(raw.sends).toEqual([1, 2, 3, 4])
    expect(observed).toEqual({ text: "ok", state: { _tag: "Committed", rung: "Primary", attempts: 4 } })
  })

  test("maxAttempts1 never retries a transport failure", async () => {
    const raw = scripted(["transport"])
    await Effect.runPromise(Effect.flip(resilientRequest(raw.client, request, { protocol: "compat" })).pipe(Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts: 1 })))
    expect(raw.sends).toEqual([1])
  })

  test("an already status-filtered SDK client shares the same rejected-response counter", async () => {
    const raw = scripted([rejected(503), rejected(429, "rate_limit_error"), { status: 200, body: "ok" }])
    const text = await Effect.runPromise(resilientRequest(HttpClient.filterStatusOk(raw.client), request, { protocol: "openai" }).pipe(
      Effect.flatMap((response) => response.text), Effect.provideService(CurrentModelRetryPolicy, policy),
    ))
    expect(text).toBe("ok")
    expect(raw.sends).toEqual([1, 2, 3])
  })

  test("structured semantics choose the concrete reason before a conflicting status", async () => {
    const found = await Effect.runPromise(Effect.forEach([
      { status: 401, body: JSON.stringify({ error: { type: "ModelError", message: "model fixture is not supported" } }) },
      { status: 402, body: JSON.stringify({ error: { code: "invalid_api_key", message: "fixture" } }) },
    ], (reply) => Effect.gen(function* () {
      const raw = scripted([reply])
      const error = yield* Effect.flip(resilientRequest(raw.client, request, { protocol: "compat" }))
      return { tag: AiError.isAiError(error) ? error.reason._tag : error._tag, kind: modelFailureOf(error), sends: raw.sends }
    }), { concurrency: 1 }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(found).toEqual([
      { tag: "InvalidRequestError", kind: Option.some("InvalidRequest"), sends: [1] },
      { tag: "AuthenticationError", kind: Option.some("Authentication"), sends: [1] },
    ])
  })

  test("terminal HTTP errors retain bounded structured diagnostics and their exact raw body cause", async () => {
    const message = `fixture provider diagnostic ${"x".repeat(600)}`
    const bodies = [JSON.stringify({ error: { message } }), JSON.stringify({ message }), JSON.stringify({ error: message })]
    const failures = await Effect.runPromise(Effect.forEach(bodies, (body) => Effect.gen(function* () {
      const raw = scripted([{ status: 400, body }])
      const error = yield* Effect.flip(resilientRequest(raw.client, request, { protocol: "compat" }))
      return { error, sends: raw.sends, body }
    }), { concurrency: 1 }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    failures.forEach(({ error, sends, body }) => {
      expect(AiError.isAiError(error)).toBe(true)
      if (!AiError.isAiError(error)) return
      expect(error.module).toBe("Models")
      expect(error.cause).toBe(error.reason)
      expect(error.reason._tag).toBe("InvalidRequestError")
      expect("description" in error.reason ? error.reason.description : undefined).toBe(message.slice(0, 500))
      expect("http" in error.reason ? error.reason.http?.body : undefined).toBe(body)
      expect(modelFailureOf(error)).toEqual(Option.some("InvalidRequest"))
      expect(sends).toEqual([1])
    })
  })

  test("structured permanent refusals beat generic status before any retry", async () => {
    const raw = scripted([rejected(429, "invalid_request_error", "invalid tool schema")])
    const failed = await Effect.runPromise(Effect.flip(resilientRequest(raw.client, request, { protocol: "compat" })).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(raw.sends).toEqual([1])
    expect(modelFailureOf(failed)).toEqual(Option.some("InvalidRequest"))
    expect(AiError.isAiError(failed) && "http" in failed.reason ? failed.reason.http?.body : "missing").toBe(rejected(429, "invalid_request_error", "invalid tool schema").body)
  })

  test("a distinct fallback consumes only the reserved fourth attempt", async () => {
    const raw = scripted([rejected(503), rejected(503), rejected(503), { status: 200, body: "fallback" }])
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const call = yield* makeModelRequestCall({ reserveFallback: true })
      const first = yield* Effect.flip(resilientRequest(raw.client, request, { protocol: "anthropic" }).pipe(Effect.provideService(CurrentModelRequestCall, Option.some(call))))
      const entered = yield* enterModelFallback(call, first)
      const response = yield* resilientRequest(raw.client, request, { protocol: "anthropic" }).pipe(Effect.provideService(CurrentModelRequestCall, Option.some(call)))
      return { entered, text: yield* response.text, state: yield* modelRequestSnapshot(call), twice: yield* enterModelFallback(call, first) }
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(raw.sends).toEqual([1, 2, 3, 4])
    expect(observed).toEqual({ entered: true, text: "fallback", state: { _tag: "Committed", rung: "Fallback", attempts: 4 }, twice: false })
  })

  test("a callback failure replacing the exhausted transport failure cannot enter fallback", async () => {
    const raw = scripted([rejected(503), rejected(503), rejected(503)])
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const call = yield* makeModelRequestCall({ reserveFallback: true })
      const transient = yield* Effect.flip(resilientRequest(raw.client, request, { protocol: "anthropic" }).pipe(Effect.provideService(CurrentModelRequestCall, Option.some(call))))
      const before = yield* modelRequestSnapshot(call)
      const refused = yield* Effect.forEach([
        harnessError("model.unavailable", "fixture callback failed"),
        new TurnClosed({ session: ConversationId.make("00000000-0000-4000-8000-000000000001"), turn: 1, reason: "cancelled" }),
        new Error("fixture callback failed"),
        AiError.make({ module: "Fixture", method: "request", reason: new AiError.AuthenticationError({ kind: "InvalidKey" }) }),
      ], (error) => enterModelFallback(call, error), { concurrency: 1 })
      const unchanged = yield* modelRequestSnapshot(call)
      return { refused, before, unchanged, actual: yield* enterModelFallback(call, transient) }
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(observed.refused).toEqual([false, false, false, false])
    expect(observed.unchanged).toEqual(observed.before)
    expect(observed.actual).toBe(true)
    expect(raw.sends).toEqual([1, 2, 3])
  })

  test("a direct child HTTP call after parent handoff has a new counter and identity", async () => {
    const parent = scripted([{ status: 200, body: "parent" }])
    const child = scripted(["transport", { status: 200, body: "child" }])
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const call = yield* makeModelRequestCall({ reserveFallback: false })
      const first = yield* resilientRequest(parent.client, request, { protocol: "compat" }).pipe(Effect.provideService(CurrentModelRequestCall, Option.some(call)))
      const second = yield* resilientRequest(child.client, request, { protocol: "compat" }).pipe(Effect.provideService(CurrentModelRequestCall, Option.some(call)))
      return {
        texts: [yield* first.text, yield* second.text], independent: second.modelAttempt.call !== call,
        parent: yield* modelRequestSnapshot(call), child: yield* modelRequestSnapshot(second.modelAttempt.call),
        ordinals: [first.modelAttempt.ordinal, second.modelAttempt.ordinal],
      }
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts: 2 })))
    expect(observed).toEqual({ texts: ["parent", "child"], independent: true, parent: { _tag: "Committed", rung: "Primary", attempts: 1 }, child: { _tag: "Committed", rung: "Primary", attempts: 2 }, ordinals: [1, 2] })
    expect(parent.sends).toEqual([1])
    expect(child.sends).toEqual([1, 2])
  })

  test("one-shot stream and FormData bodies are not replayed or sent to a fallback", async () => {
    const observed = await Effect.runPromise(Effect.forEach([
      request.pipe(HttpClientRequest.bodyStream(Stream.succeed(new Uint8Array([1])))),
      request.pipe(HttpClientRequest.bodyFormData(new FormData())),
    ], (oneShot) => Effect.gen(function* () {
      const raw = scripted([rejected(503)])
      const call = yield* makeModelRequestCall({ reserveFallback: true })
      const error = yield* Effect.flip(resilientRequest(raw.client, oneShot, { protocol: "anthropic" }).pipe(Effect.provideService(CurrentModelRequestCall, Option.some(call))))
      return { sends: raw.sends, fallback: yield* enterModelFallback(call, error) }
    }), { concurrency: 1 }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(observed).toEqual([{ sends: [1], fallback: false }, { sends: [1], fallback: false }])
  })

  test("concurrent requests read their own dynamic policy", async () => {
    const observed = await Effect.runPromise(Effect.forEach([1, 3], (maxAttempts) => Effect.gen(function* () {
      const raw = scripted([rejected(503), rejected(503), rejected(503)])
      yield* Effect.flip(resilientRequest(raw.client, request, { protocol: "anthropic" }))
      return raw.sends.length
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts })), { concurrency: 2 }))
    expect(observed).toEqual([1, 3])
  })

  test("Retry-After is capped in the actual wait and a longer wait cannot cross the deadline", async () => {
    const sends: Array<number> = []
    const raw = HttpClient.make((request) => Effect.gen(function* () {
      sends.push(yield* Clock.currentTimeMillis)
      return HttpClientResponse.fromWeb(request, sends.length === 1
        ? new Response("busy", { status: 503, headers: { "retry-after": "3600" } }) : new Response("ok"))
    }))
    expect(await inClock(resilientRequest(raw, request, { protocol: "anthropic" }).pipe(
      Effect.flatMap((response) => response.text), Effect.provideService(CurrentModelRetryPolicy, { ...policy, retryAfterMaxMs: 20 }),
    ))).toBe("ok")
    expect(sends[1]! - sends[0]!).toBe(20)
    const limited = scripted([rejected(503)])
    const failure = await inClock(Effect.flip(resilientRequest(limited.client, request, { protocol: "anthropic" })).pipe(
      Effect.provideService(CurrentModelRetryPolicy, { ...policy, totalTimeoutMs: 10, backoff: { initialMs: 20, maxMs: 20, jitter: 0 } }),
    ))
    expect(modelFailureOf(failure)).toEqual(Option.some("Timeout"))
    expect(limited.sends).toEqual([1])
  })

  test("interrupting a pending retry wait sends no later attempt", async () => {
    const sends: Array<number> = []
    const stopped = await Effect.runPromise(Effect.gen(function* () {
      const sent = yield* Deferred.make<void>()
      const raw = HttpClient.make((request) => Effect.sync(() => sends.push(1)).pipe(
        Effect.andThen(Deferred.succeed(sent, undefined)),
        Effect.as(HttpClientResponse.fromWeb(request, new Response("busy", { status: 503 }))),
      ))
      const fiber = yield* Effect.forkChild(resilientRequest(raw, request, { protocol: "anthropic" }).pipe(
        Effect.provideService(CurrentModelRetryPolicy, { ...policy, backoff: { initialMs: 1000, maxMs: 1000, jitter: 0 } }),
      ))
      yield* Deferred.await(sent)
      yield* TestClock.adjust("1 milli")
      yield* Fiber.interrupt(fiber)
      const exit = yield* Fiber.await(fiber)
      yield* TestClock.adjust("10 seconds")
      return Exit.hasInterrupts(exit)
    }).pipe(Effect.provide(TestClock.layer()), Effect.timeout("2 seconds")))
    expect(stopped).toBe(true)
    expect(sends).toEqual([1])
  })

  test("request timeouts abort the pending request and retain Timeout", async () => {
    const signals: Array<AbortSignal> = []
    const raw = HttpClient.make((_request, _url, signal) => Effect.sync(() => signals.push(signal)).pipe(Effect.andThen(Effect.never)))
    const failed = await inClock(Effect.flip(resilientRequest(raw, request, { protocol: "anthropic" })).pipe(Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts: 1, requestTimeoutMs: 10, totalTimeoutMs: 100 })))
    expect(modelFailureOf(failed)).toEqual(Option.some("Timeout"))
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
  })

  test("external interruption aborts pending headers without retrying", async () => {
    const signals: Array<AbortSignal> = []
    const interrupted = await Effect.runPromise(Effect.gen(function* () {
      const sent = yield* Deferred.make<void>()
      const raw = HttpClient.make((_request, _url, signal) => Effect.sync(() => signals.push(signal)).pipe(
        Effect.andThen(Deferred.succeed(sent, undefined)), Effect.andThen(Effect.never),
      ))
      const fiber = yield* Effect.forkChild(resilientRequest(raw, request, { protocol: "anthropic" }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
      yield* Deferred.await(sent)
      yield* Fiber.interrupt(fiber)
      return Exit.hasInterrupts(yield* Fiber.await(fiber))
    }).pipe(Effect.timeout("2 seconds")))
    expect(interrupted).toBe(true)
    expect(signals).toHaveLength(1)
    expect(signals[0]?.aborted).toBe(true)
  })

  test("a rejected body is canceled before its idle failure is retried", async () => {
    const observed: Array<string> = []
    const raw = HttpClient.make((request) => Effect.sync(() => {
      observed.push("send")
      return HttpClientResponse.fromWeb(request, observed.length === 1
        ? new Response(new ReadableStream({ cancel: () => { observed.push("cancel") } }), { status: 503 })
        : new Response("ok"))
    }))
    const text = await inClock(resilientRequest(raw, request, { protocol: "anthropic" }).pipe(
      Effect.flatMap((response) => response.text),
      Effect.provideService(CurrentModelRetryPolicy, { ...policy, bodyIdleTimeoutMs: 5 }),
    ))
    expect(text).toBe("ok")
    expect(observed).toEqual(["send", "cancel", "send"])
  })

  test("body caches preserve exact bytes and hide unguarded original readers and attempt state from JSON", async () => {
    const raw = scripted([{ status: 200, body: "{\"fixture\":true}", headers: { "x-request-id": "fixture-request" } }])
    const observed = await Effect.runPromise(Effect.gen(function* () {
      const response = yield* resilientRequest(raw.client, request, { protocol: "openai" })
      return {
        json: yield* response.json, text: yield* response.text,
        bytes: [...new Uint8Array(yield* response.arrayBuffer)],
        header: response.headers["x-request-id"], status: response.status,
        original: Reflect.has(response, "original"), rawSource: Reflect.has(response, "rawSource"),
        web: HttpClientResponse.toWeb(response as HttpClientResponse.HttpClientResponse), serialized: JSON.stringify(response),
      }
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(observed.json).toEqual({ fixture: true })
    expect(observed.text).toBe('{"fixture":true}')
    expect(observed.bytes).toEqual([...new TextEncoder().encode('{"fixture":true}')])
    expect(observed.header).toBe("fixture-request")
    expect(observed.status).toBe(200)
    expect(observed.original).toBe(false)
    expect(observed.rawSource).toBe(false)
    expect(observed.web).toEqual(Option.none())
    expect(observed.serialized).not.toContain("modelAttempt")
    expect(observed.serialized).not.toContain("maxAttempts")
  })

  test("a stalled body after successful headers is final and its stream is canceled", async () => {
    const sends: Array<number> = []
    const canceled: Array<boolean> = []
    const raw = HttpClient.make((request) => Effect.sync(() => {
      sends.push(1)
      return HttpClientResponse.fromWeb(request, new Response(new ReadableStream({ cancel: () => { canceled.push(true) } })))
    }))
    const failed = await inClock(Effect.gen(function* () {
      const response = yield* resilientRequest(raw, request, { protocol: "anthropic" })
      return yield* Effect.flip(response.text)
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, { ...policy, bodyIdleTimeoutMs: 10, totalTimeoutMs: 100 })))
    expect(modelFailureOf(failed)).toEqual(Option.some("Timeout"))
    expect(sends).toEqual([1])
    expect(canceled).toEqual([true])
  })

  test("a progressing body may take longer than the idle interval", async () => {
    const raw = HttpClient.make((request) => Effect.gen(function* () {
      const body = yield* Stream.toReadableStreamEffect(Stream.fromIterable(["a", "b", "c"]).pipe(Stream.mapEffect((text) => Effect.sleep("4 millis").pipe(Effect.as(new TextEncoder().encode(text))))))
      return HttpClientResponse.fromWeb(request, new Response(body))
    }))
    const text = await inClock(Effect.gen(function* () {
      const response = yield* resilientRequest(raw, request, { protocol: "anthropic" })
      return yield* response.text
    }).pipe(Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts: 1, bodyIdleTimeoutMs: 5, totalTimeoutMs: 100 })))
    expect(text).toBe("abc")
  })

  test("oversized errors fail as bounded InvalidResponse without replay; small HTML503 can retry", async () => {
    const huge = scripted([{ status: 503, body: "x".repeat(65537) }])
    const failed = await Effect.runPromise(Effect.flip(resilientRequest(huge.client, request, { protocol: "anthropic" })).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(modelFailureOf(failed)).toEqual(Option.some("InvalidResponse"))
    expect(huge.sends).toEqual([1])
    const html = scripted([{ status: 503, body: "<html>temporarily unavailable</html>" }, { status: 200, body: "ok" }])
    expect(await Effect.runPromise(resilientRequest(html.client, request, { protocol: "anthropic" }).pipe(Effect.flatMap((response) => response.text), Effect.provideService(CurrentModelRetryPolicy, policy)))).toBe("ok")
    expect(html.sends).toEqual([1, 2])
  })

  test.each([503, 429])("a reset rejected %i body retains its retryable status before handoff", async (status) => {
    const sends: Array<number> = []
    const raw = HttpClient.make((request) => Effect.sync(() => {
      sends.push(1)
      return HttpClientResponse.fromWeb(request, sends.length === 1
        ? new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture body reset")) } }), { status })
        : new Response("ok"))
    }))
    const result = await Effect.runPromise(resilientRequest(raw, request, { protocol: "compat" }).pipe(
      Effect.flatMap((response) => response.text), Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts: 2 }),
    ))
    expect(result).toBe("ok")
    expect(sends).toEqual([1, 1])
  })

  test("an empty rejected 503 body retains its retryable status", async () => {
    const sends: Array<number> = []
    const raw = HttpClient.make((request) => Effect.sync(() => {
      sends.push(1)
      return HttpClientResponse.fromWeb(request, sends.length === 1 ? new Response(null, { status: 503 }) : new Response("ok"))
    }))
    const result = await Effect.runPromise(resilientRequest(raw, request, { protocol: "compat" }).pipe(
      Effect.flatMap((response) => response.text), Effect.provideService(CurrentModelRetryPolicy, { ...policy, maxAttempts: 2 }),
    ))
    expect(result).toBe("ok")
    expect(sends).toEqual([1, 1])
  })

  test.each([false, true])("a rejected 401 remains Authentication when its body is %s (reset/empty)", async (empty) => {
    const sends: Array<number> = []
    const raw = HttpClient.make((request) => Effect.sync(() => {
      sends.push(1)
      return HttpClientResponse.fromWeb(request, new Response(empty ? null : new ReadableStream({ start(controller) { controller.error(new Error("fixture body reset")) } }), {
        status: 401, headers: { "x-request-id": "rejected-fixture" },
      }))
    }))
    const failure = await Effect.runPromise(Effect.flip(resilientRequest(raw, request, { protocol: "compat" })).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(modelFailureOf(failure)).toEqual(Option.some("Authentication"))
    expect(AiError.isAiError(failure) && "http" in failure.reason ? failure.reason.http?.response : undefined).toEqual({ status: 401, headers: { "x-request-id": "rejected-fixture" } })
    expect(sends).toEqual([1])
  })

  test("structured evidence read before a rejected-body reset still outranks generic status", async () => {
    const prefix = '{"error":{"code":"invalid_api_key"}}'
    const sends: Array<number> = []
    const raw = HttpClient.make((request) => Effect.sync(() => {
      sends.push(1)
      const chunks: Array<number> = []
      return HttpClientResponse.fromWeb(request, new Response(new ReadableStream({ pull(controller) {
        chunks.push(1)
        if (chunks.length === 1) controller.enqueue(new TextEncoder().encode(prefix))
        else controller.error(new Error("fixture body reset after evidence"))
      } }), { status: 503 }))
    }))
    const failure = await Effect.runPromise(Effect.flip(resilientRequest(raw, request, { protocol: "compat" })).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(modelFailureOf(failure)).toEqual(Option.some("Authentication"))
    expect(AiError.isAiError(failure) && "http" in failure.reason ? failure.reason.http?.body : undefined).toBe(prefix)
    expect(sends).toEqual([1])
  })

  test("a reset successful body is final after handoff", async () => {
    const sends: Array<number> = []
    const raw = HttpClient.make((request) => Effect.sync(() => {
      sends.push(1)
      return HttpClientResponse.fromWeb(request, new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture successful body reset")) } })))
    }))
    const failure = await Effect.runPromise(Effect.flip(resilientRequest(raw, request, { protocol: "compat" }).pipe(Effect.flatMap((response) => response.text))).pipe(Effect.provideService(CurrentModelRetryPolicy, policy)))
    expect(HttpClientError.isHttpClientError(failure) && failure.reason._tag).toBe("DecodeError")
    expect(sends).toEqual([1])
  })
})
