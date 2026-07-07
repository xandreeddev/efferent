import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { classifyLlmError, rejectEmptyResponse } from "./retry.js"

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
