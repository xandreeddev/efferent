import { describe, expect, test } from "bun:test"
import { AiError } from "effect/ai"
import { HttpClientError, HttpClientRequest } from "effect/http"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Logger, Option, Ref, References, Stream } from "effect"
import { TestClock } from "effect/testing"
import { CurrentEmptyResponseTolerance } from "@xandreed/core"
import { classifyLlmError, LLM_CALL_BUDGET_MS, makeCallBudget, rejectEmptyResponse, retryableLlm, retryableLlmStream } from "./retry.js"
import type { CallBudget } from "./retry.js"

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
const classify = (error: unknown) => classifyLlmError(error, Date.now())

/** A logger keeping each line's text and its `llm.model` annotation. */
const capturingLogs = (logged: Array<readonly [string, unknown]>) => Logger.layer([Logger.make((options) => {
  logged.push([[options.message].flat().join(" "), options.fiber.getRef(References.CurrentLogAnnotations)["llm.model"]])
})])

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

  test("429 with a Retry-After beyond the honored cap is a DAILY QUOTA — permanent", () => {
    const quota429 = (retryAfter: string) => httpError(429, { "retry-after": retryAfter })
    // Seconds form: 1h is a quota, 5s is an outage blip.
    expect(classify(quota429("3600"))).toBe("permanent")
    expect(classify(quota429("5"))).toBe("transient")
    // HTTP-date form: far future = quota.
    expect(classify(quota429(new Date(Date.now() + 7_200_000).toUTCString()))).toBe(
      "permanent",
    )
    // No header / garbage header: plain transient 429.
    expect(classify(httpError(429))).toBe("transient")
    expect(classify(quota429("soon-ish"))).toBe("transient")
  })

  test("an HTTP-date Retry-After is measured from the time it is classified at", () => {
    const at = Date.UTC(2026, 0, 1)
    const quota = httpError(429, { "retry-after": new Date(at + 7_200_000).toUTCString() })
    expect(classifyLlmError(quota, at)).toBe("permanent")
    expect(classifyLlmError(quota, at + 7_190_000)).toBe("transient")
  })

  test("an exhausted quota is permanent whatever status carried it", () => {
    expect(classify(reasonError(new AiError.QuotaExhaustedError({})))).toBe("permanent")
    expect(classify(reasonError(new AiError.QuotaExhaustedError({ http: { request, response: { status: 429, headers: {} } } })))).toBe("permanent")
  })
})

describe("retryableLlm", () => {
  /** How many attempts a call failing with `error` (then succeeding) takes, the backoff run on a test clock. */
  const attempts = (error: AiError.AiError) => Effect.runPromise(Effect.gen(function* () {
    const count = yield* Ref.make(0)
    const call = Ref.updateAndGet(count, (n) => n + 1).pipe(Effect.flatMap((n) => n === 1 ? Effect.fail(error) : Effect.succeed("ok")))
    const fiber = yield* Effect.forkChild(Effect.exit(retryableLlm("test")(call)))
    yield* TestClock.adjust("1 minute")
    yield* Fiber.join(fiber)
    return yield* Ref.get(count)
  }).pipe(Effect.provide(TestClock.layer())))

  test("an exhausted quota fails at once; a plain 429 is retried", async () => {
    expect(await attempts(reasonError(new AiError.QuotaExhaustedError({ http: { request, response: { status: 429, headers: {} } } })))).toBe(1)
    expect(await attempts(httpError(429))).toBe(2)
  })

  test("a transient failure that exhausts the retries is logged with its model as an annotation, not in its text", async () => {
    const logged: Array<readonly [string, unknown]> = []
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(Effect.exit(retryableLlm("gw:slow")(Effect.fail(httpError(503)))))
      yield* TestClock.adjust("1 minute")
      yield* Fiber.join(fiber)
    }).pipe(Effect.provide(TestClock.layer()), Effect.provide(capturingLogs(logged))))
    expect(logged).toHaveLength(1)
    expect(logged[0]?.[0]).toStartWith("transient failure exhausted retries: ")
    expect(logged[0]?.[0]).not.toContain("gw:slow")
    expect(logged[0]?.[1]).toBe("gw:slow")
  })
})

describe("retryableLlm within a call budget", () => {
  /** Runs `call` under `retryableLlm` on a test clock moved an hour on: its attempts, its time and its failure. */
  const run = (
    call: (budget: CallBudget) => Effect.Effect<unknown, AiError.AiError>,
    budgetMs?: number,
    logged: Array<readonly [string, unknown]> = [],
  ) =>
    Effect.runPromise(Effect.gen(function* () {
      const attempts = yield* Ref.make(0)
      const budget = yield* makeCallBudget(budgetMs)
      const counted = Ref.update(attempts, (n) => n + 1).pipe(Effect.andThen(call(budget)))
      const fiber = yield* Effect.forkChild(Effect.timed(Effect.flip(retryableLlm("gw:hung", budget)(counted))))
      yield* TestClock.adjust("1 hour")
      const [elapsed, error] = yield* Fiber.join(fiber)
      return { attempts: yield* Ref.get(attempts), elapsed: Duration.toMillis(elapsed), error: String(error) }
    }).pipe(Effect.orDie, Effect.provide(TestClock.layer()), Effect.provide(capturingLogs(logged))))

  test("a hung call: the first attempt is cut at 300 s, the next at the budget's deadline, and no attempt follows", async () => {
    const result = await run(() => Effect.never)
    expect(result.attempts).toBe(2)
    expect(result.elapsed).toBe(LLM_CALL_BUDGET_MS)
    expect(result.error).toContain("the gw:hung call reached its 600s budget after 2 attempts and was cut off")
  })

  test("no attempt starts at or after the deadline", async () => {
    const result = await run(() => Effect.succeed("ran"), 0)
    expect(result.attempts).toBe(0)
    expect(result.error).toContain("the gw:hung call reached its 0s budget after 0 attempts and was cut off")
  })

  test("once the call hands a tool call off, its attempt is no longer bounded and a transient failure is final", async () => {
    const logged: Array<readonly [string, unknown]> = []
    const result = await run((budget) => Deferred.succeed(budget.handedOff, undefined).pipe(
      Effect.andThen(Effect.sleep("400 seconds")),
      Effect.andThen(Effect.fail(httpError(503))),
    ), undefined, logged)
    expect(result.attempts).toBe(1)
    expect(result.elapsed).toBe(400_000)
    expect(result.error).toContain("Server error")
    expect(logged.map(([message, model]) => [message.split(": ")[0], model])).toEqual([["transient failure after a tool started was final", "gw:hung"]])
  })
})

describe("rejectEmptyResponse", () => {
  test("an empty-content 200 fails transient; content passes through unchanged", async () => {
    const empty = await Effect.runPromiseExit(
      rejectEmptyResponse("test")(Effect.succeed({ content: [{ type: "finish" }] })),
    )
    expect(empty._tag).toBe("Failure")
    const error = Exit.isFailure(empty) ? Cause.findErrorOption(empty.cause) : Option.none()
    expect(classify(Option.getOrUndefined(error))).toBe("transient")

    const full = await Effect.runPromise(
      rejectEmptyResponse("test")(
        Effect.succeed({ content: [{ type: "text", text: "hi" }], usage: { totalTokens: 1 } }),
      ),
    )
    expect(full.usage.totalTokens).toBe(1)
  })

  test("with the loop's tolerance set, a post-tool empty response passes — the model is DONE, not down", async () => {
    // Without tolerance the empty rides the retry ladder and parks the turn
    // (live-caught: math turns burning full 120s budgets after render_math
    // succeeded, ui composers riding 55s deadlines after their last patch).
    const passed = await Effect.runPromise(
      rejectEmptyResponse("test")(Effect.succeed({ content: [{ type: "finish" }] })).pipe(
        Effect.provideService(CurrentEmptyResponseTolerance, true),
      ),
    )
    expect(passed.content).toEqual([{ type: "finish" }])
  })
})

/** Attempt-scripted stream: run N delegates to `runs[attempt]` (clamped to
 *  the last), so retries observably advance the script. */
const scripted = (runs: ReadonlyArray<Stream.Stream<unknown, unknown>>) => {
  const attempts: Array<number> = []
  const stream = Stream.unwrap(
    Effect.sync(() => {
      attempts.push(attempts.length + 1)
      return runs[Math.min(attempts.length - 1, runs.length - 1)] ?? Stream.empty
    }),
  )
  return { attempts, stream }
}

const transient500 = httpError(500)
const permanent400 = httpError(400)
const delta = { type: "text-delta", id: "text-1", delta: "hi" }
const finish = { type: "finish", reason: "stop", usage: { totalTokens: 1 } }

const collect = (stream: Stream.Stream<unknown, unknown>) =>
  Effect.runPromise(
    Stream.runCollect(stream),
  )

describe("retryableLlmStream", () => {
  test("a transient failure BEFORE any content retries; the retry's parts arrive once", async () => {
    const { attempts, stream } = scripted([
      Stream.fail(transient500),
      Stream.fromIterable([delta, finish]),
    ])
    const parts = await collect(retryableLlmStream("test")(stream))
    expect(parts).toEqual([delta, finish])
    expect(attempts).toHaveLength(2)
  }, 10_000)

  test("AFTER a content part, failures are final — no retry, no duplicates", async () => {
    const { attempts, stream } = scripted([
      Stream.fromIterable([delta]).pipe(Stream.concat(Stream.fail(transient500))),
      Stream.fromIterable([delta, finish]),
    ])
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(retryableLlmStream("test")(stream)),
    )
    expect(exit._tag).toBe("Failure")
    expect(attempts).toHaveLength(1)
  })

  test("a transient failure after content is logged with its model as an annotation, not in its text", async () => {
    const logged: Array<readonly [string, unknown]> = []
    const { stream } = scripted([Stream.fromIterable([delta]).pipe(Stream.concat(Stream.fail(transient500)))])
    await Effect.runPromise(Effect.exit(Stream.runCollect(retryableLlmStream("gw:slow")(stream))).pipe(Effect.provide(capturingLogs(logged))))
    expect(logged).toHaveLength(1)
    expect(logged[0]?.[0]).toStartWith("transient stream failure was final: ")
    expect(logged[0]?.[0]).not.toContain("gw:slow")
    expect(logged[0]?.[1]).toBe("gw:slow")
  })

  test("a permanent error never retries", async () => {
    const { attempts, stream } = scripted([
      Stream.fail(permanent400),
      Stream.fromIterable([delta, finish]),
    ])
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(retryableLlmStream("test")(stream)),
    )
    expect(exit._tag).toBe("Failure")
    expect(attempts).toHaveLength(1)
  })

  test("an EMPTY stream (finish, zero content) withholds the finish and rides the retries", async () => {
    const { attempts, stream } = scripted([
      Stream.fromIterable([finish]),
      Stream.fromIterable([delta, finish]),
    ])
    const parts = await collect(retryableLlmStream("test")(stream))
    expect(parts).toEqual([delta, finish])
    expect(attempts).toHaveLength(2)
  }, 10_000)

  test("a mid-stream hang trips the idle timeout; armed, so it is final", async () => {
    const { attempts, stream } = scripted([
      Stream.fromIterable([delta]).pipe(Stream.concat(Stream.never)),
    ])
    const exit = await Effect.runPromiseExit(
      Stream.runCollect(retryableLlmStream("test", 80)(stream)),
    )
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("was cut off")
    expect(attempts).toHaveLength(1)
  })
})
