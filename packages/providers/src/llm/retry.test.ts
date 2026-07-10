import { describe, expect, test } from "bun:test"
import { Chunk, Effect, Stream } from "effect"
import { classifyLlmError, rejectEmptyResponse, retryableLlmStream } from "./retry.js"

describe("classifyLlmError", () => {
  test("429 and 5xx are transient; other 4xx permanent", () => {
    const http = (status: number) => ({ _tag: "HttpResponseError", response: { status } })
    expect(classifyLlmError(http(429))).toBe("transient")
    expect(classifyLlmError(http(500))).toBe("transient")
    expect(classifyLlmError(http(503))).toBe("transient")
    expect(classifyLlmError(http(400))).toBe("permanent")
    expect(classifyLlmError(http(401))).toBe("permanent")
    expect(classifyLlmError(http(404))).toBe("permanent")
  })

  test("transport/timeout (UnknownError) is transient; decode failures permanent", () => {
    expect(classifyLlmError({ _tag: "UnknownError" })).toBe("transient")
    expect(classifyLlmError({ _tag: "MalformedOutput" })).toBe("permanent")
    expect(classifyLlmError("boom")).toBe("permanent")
  })

  test("429 with a Retry-After beyond the honored cap is a DAILY QUOTA — permanent", () => {
    const quota429 = (retryAfter: string) => ({
      _tag: "HttpResponseError",
      response: { status: 429, headers: { "retry-after": retryAfter } },
    })
    // Seconds form: 1h is a quota, 5s is an outage blip.
    expect(classifyLlmError(quota429("3600"))).toBe("permanent")
    expect(classifyLlmError(quota429("5"))).toBe("transient")
    // HTTP-date form: far future = quota.
    expect(classifyLlmError(quota429(new Date(Date.now() + 7_200_000).toUTCString()))).toBe(
      "permanent",
    )
    // No header / garbage header: plain transient 429.
    expect(
      classifyLlmError({ _tag: "HttpResponseError", response: { status: 429, headers: {} } }),
    ).toBe("transient")
    expect(classifyLlmError(quota429("soon-ish"))).toBe("transient")
  })
})

describe("rejectEmptyResponse", () => {
  test("an empty-content 200 fails transient; content passes through unchanged", async () => {
    const empty = await Effect.runPromiseExit(
      rejectEmptyResponse("test")(Effect.succeed({ content: [{ type: "finish" }] })),
    )
    expect(empty._tag).toBe("Failure")
    expect(classifyLlmError((empty as { cause: { error: unknown } }).cause.error)).toBe(
      "transient",
    )

    const full = await Effect.runPromise(
      rejectEmptyResponse("test")(
        Effect.succeed({ content: [{ type: "text", text: "hi" }], usage: { totalTokens: 1 } }),
      ),
    )
    expect(full.usage.totalTokens).toBe(1)
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

const transient500 = { _tag: "HttpResponseError", response: { status: 500 } }
const permanent400 = { _tag: "HttpResponseError", response: { status: 400 } }
const delta = { type: "text-delta", id: "text-1", delta: "hi" }
const finish = { type: "finish", reason: "stop", usage: { totalTokens: 1 } }

const collect = (stream: Stream.Stream<unknown, unknown>) =>
  Effect.runPromise(
    Stream.runCollect(stream).pipe(Effect.map(Chunk.toReadonlyArray)),
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
