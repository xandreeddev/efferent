import { describe, expect, test } from "bun:test"
import { AiError } from "effect/ai"
import { Cause, Effect, Exit, Option, Stream } from "effect"
import { CurrentEmptyResponseTolerance } from "@xandreed/core"
import { classifyLlmError, rejectEmptyResponse, retryableLlmStream } from "./retry.js"

const request = { method: "POST" as const, url: "https://gw.example/chat", urlParams: [], headers: {} }
/** A provider status failure, as the adapters build it. */
const httpError = (status: number, headers: Record<string, string> = {}) =>
  AiError.make({
    module: "Test",
    method: "generateText",
    reason: AiError.reasonFromHttpStatus({ status, http: { request, response: { status, headers } } }),
  })
const reasonError = (reason: AiError.AiErrorReason) => AiError.make({ module: "Test", method: "generateText", reason })

describe("classifyLlmError", () => {
  test("429 and 5xx are transient; other 4xx permanent", () => {
    const http = (status: number) => httpError(status)
    expect(classifyLlmError(http(429))).toBe("transient")
    expect(classifyLlmError(http(500))).toBe("transient")
    expect(classifyLlmError(http(503))).toBe("transient")
    expect(classifyLlmError(http(400))).toBe("permanent")
    expect(classifyLlmError(http(401))).toBe("permanent")
    expect(classifyLlmError(http(404))).toBe("permanent")
  })

  test("transport/timeout (UnknownError) is transient; decode failures permanent", () => {
    expect(classifyLlmError(reasonError(new AiError.UnknownError({ description: "socket hang up" })))).toBe("transient")
    // Effect's own providers report transport failures as NetworkError.
    expect(classifyLlmError(reasonError(new AiError.NetworkError({ reason: "TransportError", request, description: "reset" })))).toBe("transient")
    expect(classifyLlmError(reasonError(new AiError.InvalidOutputError({ description: "not JSON" })))).toBe("permanent")
    expect(classifyLlmError("boom")).toBe("permanent")
  })

  test("429 with a Retry-After beyond the honored cap is a DAILY QUOTA — permanent", () => {
    const quota429 = (retryAfter: string) => httpError(429, { "retry-after": retryAfter })
    // Seconds form: 1h is a quota, 5s is an outage blip.
    expect(classifyLlmError(quota429("3600"))).toBe("permanent")
    expect(classifyLlmError(quota429("5"))).toBe("transient")
    // HTTP-date form: far future = quota.
    expect(classifyLlmError(quota429(new Date(Date.now() + 7_200_000).toUTCString()))).toBe(
      "permanent",
    )
    // No header / garbage header: plain transient 429.
    expect(classifyLlmError(httpError(429))).toBe("transient")
    expect(classifyLlmError(quota429("soon-ish"))).toBe("transient")
  })
})

describe("rejectEmptyResponse", () => {
  test("an empty-content 200 fails transient; content passes through unchanged", async () => {
    const empty = await Effect.runPromiseExit(
      rejectEmptyResponse("test")(Effect.succeed({ content: [{ type: "finish" }] })),
    )
    expect(empty._tag).toBe("Failure")
    const error = Exit.isFailure(empty) ? Cause.findErrorOption(empty.cause) : Option.none()
    expect(classifyLlmError(Option.getOrUndefined(error))).toBe("transient")

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
