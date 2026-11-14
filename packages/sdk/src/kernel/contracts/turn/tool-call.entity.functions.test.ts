import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import { inProcessJournal, sessions } from "../../index.js"
import { callTool } from "./tool-call.entity.functions.js"
import { CurrentTurn } from "./current-turn.port.js"

const Echo = Tool.make("echo", { parameters: Schema.Struct({ text: Schema.String }), success: Schema.String, failure: Schema.String, failureMode: "return" })
const Dies = Tool.make("dies", { success: Schema.String })
const Plain = Tool.make("plain", { success: Schema.String, failure: Schema.Number, failureMode: "return" })
const Where = Tool.make("where", { success: Schema.String, dependencies: [CurrentTurn] })
const tools = Toolkit.make(Echo, Dies, Plain, Where)
const handlers = tools.toLayer({
  echo: ({ text }) => (text === "fail" ? Effect.fail("it failed") : Effect.succeed(text)),
  dies: () => Effect.die(new Error("the handler broke")),
  plain: () => Effect.fail(404),
  where: () => Effect.map(CurrentTurn, (session) => `turn ${session.turn}`),
})

/** Each call run with `callTool` in one open turn, and the result it gives back to store. */
const results = (calls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const all = yield* Sessions
  const session = yield* all.open(yield* all.create({ owner: "test" }))
  yield* session.append(userMessage("go"))
  const toolkit = yield* tools
  return yield* Effect.forEach(calls, (call, index) => Effect.map(callTool(toolkit, { id: `call-${index}`, ...call }, session), (draft) => (draft.message?._tag === "ToolResult" ? { ...draft.message, id: String(draft.message.id) } : draft.message)), { concurrency: 1 })
})).pipe(Effect.provide(Layer.mergeAll(handlers, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))))))

describe("callTool", () => {
  test("gives back the tool's answer, or its failure, as the result to store", async () => {
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
})
