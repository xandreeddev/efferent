import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { kernel, Sessions, stored, storedEvent, userMessage } from "@xandreed/core/kernel"
import { inProcessJournal, sessions } from "../../index.js"
import { callTool } from "./tool-call.entity.functions.js"
import { CurrentTurn } from "./current-turn.port.js"

const Echo = Tool.make("echo", { parameters: Schema.Struct({ text: Schema.String }), success: Schema.String, failure: Schema.String, failureMode: "return" })
const Dies = Tool.make("dies", { success: Schema.String })
const Plain = Tool.make("plain", { success: Schema.String, failure: Schema.Number, failureMode: "return" })
const Where = Tool.make("where", { success: Schema.String, dependencies: [CurrentTurn] })
const Sloppy = Tool.make("sloppy", { success: Schema.String, dependencies: [CurrentTurn] })
const noted = storedEvent("notes", "noted", { tags: ["trace"], data: Schema.Struct({}), skippable: true })
const tools = Toolkit.make(Echo, Dies, Plain, Where, Sloppy)
const handlers = tools.toLayer({
  echo: ({ text }) => (text === "fail" ? Effect.fail("it failed") : Effect.succeed(text)),
  dies: () => Effect.die(new Error("the handler broke")),
  plain: () => Effect.fail(404),
  where: () => Effect.map(CurrentTurn, (session) => `turn ${session.turn}`),
  // It appends a copy of a record, which a session refuses: the write needs no handling of its own in a handler.
  sloppy: () => Effect.gen(function* () {
    const turn = yield* CurrentTurn
    yield* turn.append({ ...stored(noted, {}) })
    return "stored"
  }),
})

/** Each call run with `callTool` in one open turn, and the result it stored and gave back. */
const results = (calls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const all = yield* Sessions
  const session = yield* all.open(yield* all.create({ owner: "test" }))
  yield* session.append(userMessage("go"))
  const toolkit = yield* tools
  const given = yield* Effect.forEach(calls, (call, index) => Effect.map(callTool(toolkit, { id: `call-${index}`, ...call }, session), (stored) => (stored.message?._tag === "ToolResult" ? { ...stored.message, id: String(stored.message.id) } : stored.message)), { concurrency: 1 })
  // What it gave back is what it stored, in the order of the calls.
  const kept = (yield* session.journal).flatMap((event) => (event.message?._tag === "ToolResult" ? [{ ...event.message, id: String(event.message.id) }] : []))
  expect<unknown>(kept).toEqual(given)
  return given
})).pipe(Effect.provide(Layer.mergeAll(handlers, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))))))

describe("callTool", () => {
  test("stores the tool's answer, or its failure, as the call's result, and gives the record back", async () => {
    expect(await results([{ name: "echo", params: { text: "hi" } }, { name: "echo", params: { text: "fail" } }])).toEqual([
      { _tag: "ToolResult", id: "call-0", name: "echo", result: "hi", isFailure: false },
      { _tag: "ToolResult", id: "call-1", name: "echo", result: "it failed", isFailure: true },
    ])
  })

  test("a failure that is not an Error is given back as it is", async () => {
    expect(await results([{ name: "plain", params: {} }])).toEqual([{ _tag: "ToolResult", id: "call-0", name: "plain", result: 404, isFailure: true }])
  })

  test("a handler that dies is a failed result whose text is the defect's message alone", async () => {
    expect(await results([{ name: "dies", params: {} }])).toEqual([{ _tag: "ToolResult", id: "call-0", name: "dies", result: "the handler broke", isFailure: true }])
  })

  test("an unknown tool and parameters the toolkit refuses are failed results the model reads", async () => {
    const [unknown, wrong] = await results([{ name: "search", params: {} }, { name: "echo", params: { text: 3 } }])
    expect(unknown).toMatchObject({ _tag: "ToolResult", name: "search", isFailure: true })
    expect(wrong).toMatchObject({ _tag: "ToolResult", name: "echo", isFailure: true })
  })

  test("runs the call in the turn it is given: a handler reads it as CurrentTurn", async () => {
    expect(await results([{ name: "where", params: {} }])).toEqual([{ _tag: "ToolResult", id: "call-0", name: "where", result: "turn 1", isFailure: false }])
  })

  test("a write that fails inside a handler is a failed result whose text is the refusal's message alone", async () => {
    // A tool's turn takes its writes with no failure in their type: a write the session refuses is a defect of the
    // handler, which the model reads as any failed call, and nothing of it is stored but that result.
    expect(await results([{ name: "sloppy", params: {} }])).toEqual([{
      _tag: "ToolResult",
      id: "call-0",
      name: "sloppy",
      result: "this value is not a record `stored(definition, data)` made from a definition `storedEvent` made: build a record with `stored`, or with `userMessage`, `assistantMessage` or `toolResult`, never by hand or as a copy",
      isFailure: true,
    }])
  })
})
