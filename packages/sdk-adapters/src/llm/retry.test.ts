import { describe, expect, it } from "bun:test"
import { AiError } from "@effect/ai"
import { Effect, Option, Ref } from "effect"
import { isTransientAiError, retryableLlm } from "./retry.js"

const request = {
  method: "POST" as const,
  url: "https://example.test/chat",
  urlParams: [] as Array<[string, string]>,
  hash: Option.none<string>(),
  headers: {} as Record<string, string>,
}

const httpError = (
  status: number,
  headers: Record<string, string> = {},
): AiError.HttpResponseError =>
  new AiError.HttpResponseError({
    module: "Test",
    method: "chat",
    reason: "StatusCode",
    request,
    response: { status, headers },
    body: "",
    description: "",
  })

const unknown = (description: string): AiError.UnknownError =>
  new AiError.UnknownError({ module: "Test", method: "chat", description })

const malformed = (): AiError.MalformedOutput =>
  new AiError.MalformedOutput({ module: "Test", method: "decode", description: "bad json" })

describe("isTransientAiError", () => {
  it("treats 429 and the retryable 5xx as transient", () => {
    expect(isTransientAiError(httpError(429))).toBe(true)
    expect(isTransientAiError(httpError(500))).toBe(true)
    expect(isTransientAiError(httpError(502))).toBe(true)
    expect(isTransientAiError(httpError(503))).toBe(true)
    expect(isTransientAiError(httpError(504))).toBe(true)
  })

  it("never retries a 4xx client error (bad request / bad key)", () => {
    expect(isTransientAiError(httpError(400))).toBe(false)
    expect(isTransientAiError(httpError(401))).toBe(false)
    expect(isTransientAiError(httpError(403))).toBe(false)
    expect(isTransientAiError(httpError(404))).toBe(false)
  })

  it("retries a fetch transport/timeout failure wrapped as UnknownError", () => {
    expect(isTransientAiError(unknown("TypeError: fetch failed"))).toBe(true)
    expect(isTransientAiError(unknown("The operation was aborted due to timeout"))).toBe(true)
    expect(isTransientAiError(unknown("Error: read ECONNRESET"))).toBe(true)
  })

  it("never retries a decode bug or an opaque unknown failure", () => {
    expect(isTransientAiError(malformed())).toBe(false)
    expect(isTransientAiError(unknown("undefined is not a function"))).toBe(false)
  })
})

describe("retryableLlm", () => {
  // `retry-after: "0"` ⇒ ~0ms sleeps, so these stay fast.
  const transient = httpError(429, { "retry-after": "0" })

  it("retries a transient failure, then succeeds", async () => {
    const { result, total } = await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const eff = Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.flatMap((n) => (n < 3 ? Effect.fail(transient) : Effect.succeed("ok"))),
        )
        const result = yield* retryableLlm(eff)
        return { result, total: yield* Ref.get(calls) }
      }),
    )
    expect(result).toBe("ok")
    expect(total).toBe(3) // 2 failures + 1 success
  })

  it("does not retry a non-transient failure", async () => {
    const { failed, total } = await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const eff = Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.flatMap(() => Effect.fail(httpError(400))),
        )
        const exit = yield* Effect.exit(retryableLlm(eff))
        return { failed: exit._tag === "Failure", total: yield* Ref.get(calls) }
      }),
    )
    expect(failed).toBe(true)
    expect(total).toBe(1) // no retry
  })

  it("gives up after the retry cap and surfaces the last failure", async () => {
    const { failed, total } = await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const eff = Ref.update(calls, (n) => n + 1).pipe(Effect.zipRight(Effect.fail(transient)))
        const exit = yield* Effect.exit(retryableLlm(eff))
        return { failed: exit._tag === "Failure", total: yield* Ref.get(calls) }
      }),
    )
    expect(failed).toBe(true)
    expect(total).toBe(4) // 1 initial attempt + 3 retries (MAX_RETRIES)
  })
})
