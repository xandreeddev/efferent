import { describe, expect, it } from "bun:test"
import { AiError } from "@effect/ai"
import { type AgentLlmRetryEvent, RunContextRef } from "@xandreed/sdk-core"
import { Effect, Option, Ref } from "effect"
import {
  isTransientAiError,
  MAX_HONORED_RETRY_AFTER_MS,
  parseRetryAfter,
  planDelay,
  retryableLlm,
} from "./retry.js"

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

  // The regression: the opencode gateway answers a daily-quota 429 with
  // `Retry-After` = seconds-until-the-midnight-UTC reset (HOURS). Honoring it
  // verbatim slept the agent ~13h. It must now FAIL FAST — no retry, no sleep.
  it("does NOT retry a 429 whose Retry-After is hours away (quota wall)", async () => {
    const quota = httpError(429, { "retry-after": "48489" }) // ~13.5h
    const { failed, total } = await Effect.runPromise(
      Effect.gen(function* () {
        const calls = yield* Ref.make(0)
        const eff = Ref.update(calls, (n) => n + 1).pipe(Effect.zipRight(Effect.fail(quota)))
        const exit = yield* Effect.exit(retryableLlm(eff))
        return { failed: exit._tag === "Failure", total: yield* Ref.get(calls) }
      }),
    )
    expect(failed).toBe(true)
    expect(total).toBe(1) // failed fast, never parked
  })

  it("emits a retry notice via RunContext.onLlmRetry on each backoff", async () => {
    const notices = await Effect.runPromise(
      Effect.gen(function* () {
        const seen = yield* Ref.make<ReadonlyArray<AgentLlmRetryEvent>>([])
        const calls = yield* Ref.make(0)
        const eff = Ref.updateAndGet(calls, (n) => n + 1).pipe(
          Effect.flatMap((n) => (n < 3 ? Effect.fail(transient) : Effect.succeed("ok"))),
        )
        yield* retryableLlm(eff).pipe(
          Effect.locally(RunContextRef, {
            rootConversationId: null,
            parentNodeId: null,
            depth: 0,
            tokenPool: null,
            onLlmRetry: (e: AgentLlmRetryEvent) => Ref.update(seen, (xs) => [...xs, e]),
          }),
        )
        return yield* Ref.get(seen)
      }),
    )
    // 2 transient failures ⇒ 2 notices, numbered 1/3 and 2/3.
    expect(notices.length).toBe(2)
    expect(notices.map((n) => n.attempt)).toEqual([1, 2])
    expect(notices[0]?.maxAttempts).toBe(3)
    expect(notices[0]?.reason).toBe("HTTP 429")
  })
})

describe("parseRetryAfter", () => {
  const now = 1_000_000

  it("parses delta-seconds to ms", () => {
    expect(parseRetryAfter("0", now)).toBe(0)
    expect(parseRetryAfter("5", now)).toBe(5000)
    expect(parseRetryAfter("48489", now)).toBe(48_489_000) // the daily-quota value
  })

  it("returns undefined for an absent/empty header", () => {
    expect(parseRetryAfter(undefined, now)).toBeUndefined()
    expect(parseRetryAfter("", now)).toBeUndefined()
  })

  it("parses an HTTP-date relative to now", () => {
    const at = new Date(now + 10_000).toUTCString() // 10s in the future
    const ms = parseRetryAfter(at, now)
    // UTCString truncates to whole seconds, so allow a 1s slop.
    expect(ms).toBeGreaterThanOrEqual(9000)
    expect(ms).toBeLessThanOrEqual(10_000)
  })
})

describe("planDelay (Retry-After clamp)", () => {
  it("honors a short server wait, capped at the ceiling", () => {
    expect(planDelay(5000, 0)).toEqual({ wait: true, delayMs: 5000 })
    expect(planDelay(MAX_HONORED_RETRY_AFTER_MS, 0)).toEqual({
      wait: true,
      delayMs: MAX_HONORED_RETRY_AFTER_MS,
    })
  })

  it("REFUSES a wait longer than the ceiling (quota/outage ⇒ fail fast)", () => {
    expect(planDelay(MAX_HONORED_RETRY_AFTER_MS + 1, 0)).toEqual({ wait: false, delayMs: 0 })
    expect(planDelay(48_489_000, 0)).toEqual({ wait: false, delayMs: 0 }) // the bug
  })

  it("falls back to exponential backoff when no header, within the ceiling", () => {
    const { wait, delayMs } = planDelay(undefined, 0)
    expect(wait).toBe(true)
    expect(delayMs).toBeGreaterThan(0)
    expect(delayMs).toBeLessThanOrEqual(MAX_HONORED_RETRY_AFTER_MS)
  })
})
