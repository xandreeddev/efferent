import { describe, expect, test } from "bun:test"
import { Tool } from "effect/ai"
import { Effect, Option, Schema, SchemaGetter } from "effect"
import { FinishReason } from "@xandreed/core"
import type { ResponseVerdict } from "./response-gate.entity.js"
import { lengthCorrective, malformedCall, MAX_CUT_CORRECTIVES, replyCutFailure, truncatedMessage, verdictOf } from "./response-gate.entity.functions.js"

describe("verdictOf: whether a response may run its tool calls", () => {
  /** Each reason's verdict for a response that holds calls the loop would run, and for one that holds none. */
  const verdicts: Readonly<Record<FinishReason, readonly [withCalls: ResponseVerdict, withoutCalls: ResponseVerdict]>> = {
    stop: [{ _tag: "Whole" }, { _tag: "Whole" }],
    "tool-calls": [{ _tag: "Whole" }, { _tag: "Whole" }],
    pause: [{ _tag: "Whole" }, { _tag: "Whole" }],
    length: [{ _tag: "Cut", reason: "length" }, { _tag: "Cut", reason: "length" }],
    "content-filter": [{ _tag: "Cut", reason: "content-filter" }, { _tag: "Cut", reason: "content-filter" }],
    error: [{ _tag: "Cut", reason: "error" }, { _tag: "Cut", reason: "error" }],
    other: [{ _tag: "Cut", reason: "other" }, { _tag: "Cut", reason: "other" }],
    // No finish reason from the provider: a reply holding calls is cut, one in text (or empty) completes.
    unknown: [{ _tag: "Cut", reason: "unknown" }, { _tag: "Whole" }],
  }

  // The table is a Record over the reasons (a new one fails to compile until it has a verdict); every one runs.
  test.each([...FinishReason.literals])("%s", (reason) => {
    expect([verdictOf(reason, true), verdictOf(reason, false)]).toEqual([...verdicts[reason]])
  })

  test("unknown cuts a reply only when it holds calls the loop would run", () => {
    expect(verdictOf("unknown", true)).toEqual({ _tag: "Cut", reason: "unknown" })
    expect(verdictOf("unknown", false)).toEqual({ _tag: "Whole" })
  })
})

describe("malformedCall: the first call of a whole response the loop will not run", () => {
  /** The check run: it is an Effect, decoding as the toolkit decodes. */
  const checked = (...args: Parameters<typeof malformedCall>) => Effect.runPromise(malformedCall(...args))
  const Echo = Tool.make("echo", { parameters: Schema.Struct({ value: Schema.String }) })
  // A tool whose parameters are a JSON Schema the toolkit passes through: it checks its own.
  const External = Tool.dynamic("external", {
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  })
  const tools = { echo: Echo, external: External }

  test("a tool the step does not have", async () => {
    expect(await checked([{ name: "not_a_tool", params: {} }], tools)).toEqual(Option.some({ _tag: "NotFound", toolName: "not_a_tool" }))
  })

  test.each(["constructor", "toString", "__proto__", "hasOwnProperty"])("a name the tools' object inherits, %s, is a tool the step does not have", async (name) => {
    expect(await checked([{ name, params: {} }], tools)).toEqual(Option.some({ _tag: "NotFound", toolName: name }))
  })

  test("parameters its tool's schema does not decode, with the decoder's report", async () => {
    expect(await checked([{ name: "echo", params: { value: 7 } }], tools)).toEqual(Option.some({ _tag: "Invalid", toolName: "echo", description: "Expected string\n  at [\"value\"]" }))
    expect(await checked([{ name: "echo", params: {} }], tools)).toEqual(Option.some({ _tag: "Invalid", toolName: "echo", description: "Missing key\n  at [\"value\"]" }))
  })

  test("a tool whose parameters are a JSON Schema passes: the loop does not check them", async () => {
    expect(await checked([{ name: "external", params: { query: 7 } }], tools)).toEqual(Option.none())
  })

  test("the first failing call is the one reported", async () => {
    const good = { name: "echo", params: { value: "ok" } }
    expect(await checked([good, { name: "missing", params: {} }, { name: "echo", params: { value: 7 } }], tools)).toEqual(Option.some({ _tag: "NotFound", toolName: "missing" }))
    expect(await checked([good, { name: "echo", params: { value: 7 } }, { name: "missing", params: {} }], tools)).toEqual(Option.some({ _tag: "Invalid", toolName: "echo", description: "Expected string\n  at [\"value\"]" }))
  })

  test("parameters that decode in an Effect (asynchronously, as the toolkit allows) are checked like any other", async () => {
    const Later = Tool.make("later", {
      parameters: Schema.Struct({
        value: Schema.String.pipe(Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transformEffect((text: string) => Effect.succeed(text).pipe(Effect.delay("1 millis"))),
          encode: SchemaGetter.transform((text: string) => text),
        })),
      }),
    })
    expect(await checked([{ name: "later", params: { value: "x" } }], { later: Later })).toEqual(Option.none())
    expect(await checked([{ name: "later", params: { value: 7 } }], { later: Later })).toEqual(Option.some({ _tag: "Invalid", toolName: "later", description: "Expected string\n  at [\"value\"]" }))
  })

  test("every call good, or none at all: nothing to report", async () => {
    expect(await checked([{ name: "echo", params: { value: "a" } }, { name: "external", params: { query: "b" } }], tools)).toEqual(Option.none())
    expect(await checked([], tools)).toEqual(Option.none())
  })
})

describe("the gate's text, exactly as the model and the host read it", () => {
  test("replyCutFailure: each tool call of a cut reply is answered, by how the reply ended", () => {
    expect(replyCutFailure("length")).toEqual({ error: "ReplyCut", message: "Your reply reached the output limit, so this call was not run. Call it again if you still need it." })
    expect(replyCutFailure("content-filter")).toEqual({ error: "ReplyCut", message: "Your reply was stopped by the provider's content filter, so this call was not run. Call it again if you still need it." })
    expect(replyCutFailure("error")).toEqual({ error: "ReplyCut", message: "Your reply was cut off by an error at the provider, so this call was not run. Call it again if you still need it." })
    expect(replyCutFailure("other")).toEqual({ error: "ReplyCut", message: "Your reply was cut short for a reason the provider did not name, so this call was not run. Call it again if you still need it." })
    expect(replyCutFailure("unknown")).toEqual({ error: "ReplyCut", message: "Your reply ended before the provider said it was complete, so this call was not run. Call it again if you still need it." })
  })

  test("lengthCorrective: after a reply cut at the output limit, with tool calls in it and without", () => {
    expect(lengthCorrective(true)).toBe("[Host note: your previous reply reached the output limit and was cut short, so the tool calls it made were not run: their results say so. Call the tools you still need again, fewer in one reply and with less text before them.]")
    expect(lengthCorrective(false)).toBe("[Host note: your previous reply reached the output limit and was cut short. Continue from where it stopped, in replies short enough to finish.]")
  })

  test("truncatedMessage: why the run stopped, for the host", () => {
    expect(MAX_CUT_CORRECTIVES).toBe(2)
    expect(truncatedMessage("length", 4, 3)).toBe("the model's replies reached the output limit 3 times in a row, the last at step 4, after 2 correctives")
    expect(truncatedMessage("content-filter", 0, 1)).toBe("the model's reply at step 0 was stopped by the provider's content filter")
  })
})
