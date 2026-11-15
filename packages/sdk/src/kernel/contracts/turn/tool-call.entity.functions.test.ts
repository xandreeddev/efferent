import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { assistantMessage, kernel, Sessions, stored, storedEvent, userMessage } from "@xandreed/core/kernel"
import { inProcessJournal, sessions } from "../../index.js"
import { paired } from "../memory/memory.entity.functions.js"
import { callTool } from "./tool-call.entity.functions.js"
import { CurrentTurn } from "./current-turn.port.js"
import { SentWhole } from "./sent-whole.port.js"
import { turnsOf } from "./turns.entity.functions.js"

const Echo = Tool.make("echo", { parameters: Schema.Struct({ text: Schema.String }), success: Schema.String, failure: Schema.String, failureMode: "return" })
const Dies = Tool.make("dies", { success: Schema.String })
const Plain = Tool.make("plain", { success: Schema.String, failure: Schema.Number, failureMode: "return" })
const Where = Tool.make("where", { success: Schema.String, dependencies: [CurrentTurn] })
const Sloppy = Tool.make("sloppy", { success: Schema.String, dependencies: [CurrentTurn] })
const noted = storedEvent("notes", "noted", { tags: ["trace"], data: Schema.Struct({}), skippable: true })
// A tool whose result must reach the model as it is stored: its annotation says so.
const Manual = Tool.make("manual", { parameters: Schema.Struct({ page: Schema.Number }), success: Schema.String, failure: Schema.String, failureMode: "return" }).annotate(SentWhole, true)
const tools = Toolkit.make(Echo, Dies, Plain, Where, Sloppy, Manual)
const handlers = tools.toLayer({
  echo: ({ text }) => (text === "fail" ? Effect.fail("it failed") : Effect.succeed(text)),
  dies: () => Effect.die(new Error("the handler broke")),
  plain: () => Effect.fail(404),
  where: () => Effect.map(CurrentTurn, (session) => `turn ${session.turn}`),
  manual: ({ page }) => (page < 1 ? Effect.fail("there is no such page") : Effect.succeed(`page ${page}`)),
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

/**
 * One answer that asks twice under one id, `same`, as a model that repeats an id would, and the first `ran` of its
 * calls run with `callTool`, one after the other as a loop runs them. What comes back: each call a memory would
 * send beside the result it would send with it (`paired`), and each call with the result `turnsOf` gives it.
 */
const repeatedId = (ran: number) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const all = yield* Sessions
  const session = yield* all.open(yield* all.create({ owner: "test" }))
  yield* session.append(userMessage("go"))
  const asked = [{ id: "same", name: "echo", params: { text: "one" } }, { id: "same", name: "echo", params: { text: "two" } }]
  yield* session.append(assistantMessage("", { toolCalls: asked }))
  const toolkit = yield* tools
  yield* Effect.forEach(asked.slice(0, ran), (call) => callTool(toolkit, call, session), { concurrency: 1, discard: true })
  const journal = yield* session.journal
  const sent = paired(journal.flatMap((event) => (event.message === undefined ? [] : [event.message])))
  return {
    sent: {
      calls: sent.flatMap((message) => (message._tag === "Assistant" ? message.toolCalls.map((call) => call.input) : [])),
      results: sent.flatMap((message) => (message._tag === "ToolResult" ? [message.result] : [])),
    },
    read: turnsOf(journal).flatMap((turn) => turn.steps.flatMap((step) => step.calls.map((call) => [call.input, Option.getOrNull(call.result)?.result ?? "no result"]))),
  }
})).pipe(Effect.provide(Layer.mergeAll(handlers, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))))))

describe("callTool", () => {
  test("two calls of one answer under one id, run in order: each is sent and read beside its own result, never the other's", async () => {
    expect(await repeatedId(2)).toEqual({
      sent: { calls: [{ text: "one" }, { text: "two" }], results: ["one", "two"] },
      read: [[{ text: "one" }, "one"], [{ text: "two" }, "two"]],
    })
    // The turn stopped after the first: that call is sent with its result, and the one that never ran is not sent.
    expect(await repeatedId(1)).toEqual({
      sent: { calls: [{ text: "one" }], results: ["one"] },
      read: [[{ text: "one" }, "one"], [{ text: "two" }, "no result"]],
    })
    expect(await repeatedId(0)).toEqual({ sent: { calls: [], results: [] }, read: [[{ text: "one" }, "no result"], [{ text: "two" }, "no result"]] })
  })

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

  test("a tool annotated SentWhole has its result stored as whole, a failed one too, and no other tool's record holds the key", async () => {
    const [page, none, plain] = await results([{ name: "manual", params: { page: 2 } }, { name: "manual", params: { page: 0 } }, { name: "echo", params: { text: "hi" } }])
    expect(page).toEqual({ _tag: "ToolResult", id: "call-0", name: "manual", result: "page 2", isFailure: false, whole: true })
    expect(none).toEqual({ _tag: "ToolResult", id: "call-1", name: "manual", result: "there is no such page", isFailure: true, whole: true })
    expect(Object.keys(plain ?? {})).toEqual(["_tag", "id", "name", "result", "isFailure"])
  })

  test("the tool's name is the model's: a name of every object, which no toolkit has, is an unknown tool and asks for nothing", async () => {
    const answers = await results([{ name: "constructor", params: {} }, { name: "__proto__", params: {} }, { name: "toString", params: {} }])
    expect(answers.map((answer) => (answer?._tag === "ToolResult" ? [answer.name, answer.isFailure, "whole" in answer] : []))).toEqual([
      ["constructor", true, false], ["__proto__", true, false], ["toString", true, false],
    ])
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
