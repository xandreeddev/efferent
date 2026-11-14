import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import { callTool, inProcessJournal, sessions } from "../../index.js"
import { ReadResult, readResult } from "./read-result.adapter.js"

const Lookup = Tool.make("lookup", { success: Schema.String })
const tools = Toolkit.make(Lookup, ReadResult)
const handlers = tools.toLayer({ lookup: () => Effect.succeed("0123456789".repeat(300)), readResult })

/** One turn: a lookup stored at place 3, then each `readResult` call, and what each stored. */
const read = (calls: ReadonlyArray<unknown>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const all = yield* Sessions
  const session = yield* all.open(yield* all.create({ owner: "test" }))
  yield* session.append(userMessage("go"))
  const toolkit = yield* tools
  yield* callTool(toolkit, { id: "c0", name: "lookup", params: {} }, session)
  return yield* Effect.forEach(calls, (params, index) => Effect.map(callTool(toolkit, { id: `c${index + 1}`, name: "readResult", params }, session), (stored) => stored.message), { concurrency: 1 })
})).pipe(Effect.provide(Layer.mergeAll(handlers, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))))))

describe("the readResult tool", () => {
  test("its description says what it reads, what it returns, its limit and which numbers to use, in fixed words", () => {
    expect(ReadResult.name).toBe("readResult")
    expect(ReadResult.description).toBe(
      "Read more of a tool result that was cut short. Returns `text`, the characters from `from` up to `to`, and `total`, the result's length: while `to` is less than `total`, call again with `from` set to `to`. One call reads at most 2000 characters. Use only the numbers a cut-short result names.",
    )
  })

  test("its parameters are described in fixed words", () => {
    expect(Tool.getJsonSchema(ReadResult)).toEqual({
      type: "object",
      properties: {
        result: { type: "integer", minimum: 1, maximum: 9007199254740991, description: "The number a cut-short result gives for itself." },
        from: { type: "integer", minimum: 0, maximum: 9007199254740991, description: "The character to start at: the number the cut-short result names, or the `to` of the last part you read." },
        length: { type: "integer", minimum: 1, maximum: 9007199254740991, description: "How many characters to read. A call reads at most 2000, whatever is asked; left out, 2000." },
      },
      required: ["result", "from"],
      additionalProperties: true,
    })
  })

  test("it reads a part of the result stored at the place it is given, a page at most, and its answer is stored whole", async () => {
    const [first, asked, last] = await read([{ result: 3, from: 0 }, { result: 3, from: 2000, length: 15 }, { result: 3, from: 2990 }])
    expect<unknown>(first).toEqual({ _tag: "ToolResult", id: "c1", name: "readResult", isFailure: false, whole: true, result: { text: "0123456789".repeat(200), from: 0, to: 2000, total: 3000 } })
    expect(asked).toMatchObject({ result: { text: "012345678901234", from: 2000, to: 2015, total: 3000 }, whole: true })
    expect(last).toMatchObject({ result: { text: "0123456789", from: 2990, to: 3000, total: 3000 } })
  })

  test("a length over the page reads a page: the call is not refused, and `to` says where it stopped", async () => {
    const [page] = await read([{ result: 3, from: 500, length: 5000 }])
    expect(page).toMatchObject({ isFailure: false, result: { from: 500, to: 2500, total: 3000 } })
  })

  test("a place with no tool result, a start past the end and parameters it does not take are failed results the model reads", async () => {
    const [nothing, past, wrong] = await read([{ result: 9, from: 0 }, { result: 3, from: 3000 }, { result: 3, from: -1 }])
    expect(nothing).toMatchObject({ isFailure: true, result: "No tool result is stored at 9: use the number a cut-short result names." })
    expect(past).toMatchObject({ isFailure: true, result: "The result at 3 is 3000 characters long: from must be less than 3000." })
    expect(wrong).toMatchObject({ name: "readResult", isFailure: true })
  })
})
