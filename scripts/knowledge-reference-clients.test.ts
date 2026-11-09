import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { referenceRequest } from "./knowledge-reference-clients.js"

const deployment = { kind: "mem0" as const, baseUrl: "https://reference.invalid", version: "fixture", revision: "fixture-sha", extractionModel: "fixture", embeddingModel: "fixture", embeddingVersion: "1", embeddingDimensions: 2, configFingerprint: "fixture", timeoutMs: 1000, pollMs: 10 }
afterEach(() => mock.restore())

test("reference clients bound responses by bytes and cancel refused bodies", async () => {
  let cancelled = 0
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(new ReadableStream({ pull: (controller) => controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)), cancel: () => { cancelled++ } })), { preconnect: () => {} }))
  const failure = await Effect.runPromise(Effect.flip(referenceRequest(deployment)("GET", "/large")))
  expect(failure).toMatchObject({ _tag: "EvaluationError", code: "unavailable", message: "The reference response exceeds 8 MiB" })
  expect(cancelled).toBe(1)
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(new ReadableStream({ cancel: () => { cancelled++ } }), { status: 403 }), { preconnect: () => {} }))
  expect((await Effect.runPromise(Effect.flip(referenceRequest(deployment)("GET", "/denied")))).message).toBe("The reference deployment refused the request with HTTP 403")
  expect(cancelled).toBe(2)
})

test("a stalled reference body is cancelled at its configured deadline", async () => {
  const reading = Effect.runSync(Deferred.make<void>())
  let cancelled = false
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async () => new Response(new ReadableStream({ pull: () => { Effect.runSync(Deferred.succeed(reading, undefined)) }, cancel: () => { cancelled = true } })), { preconnect: () => {} }))
  const error = await Effect.runPromise(Effect.gen(function* () {
    const running = yield* Effect.forkChild(Effect.result(referenceRequest(deployment)("GET", "/stalled")))
    yield* Deferred.await(reading)
    yield* TestClock.adjust(1001)
    return yield* Fiber.join(running)
  }).pipe(Effect.provide(TestClock.layer())))
  expect(error._tag === "Failure" && error.failure.message).toBe("The reference request exceeded its configured deadline")
  expect(cancelled).toBe(true)
})
