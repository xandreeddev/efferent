import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { callTool, flatMemory, inProcessJournal, Memory, modelAnswer, scriptedModel, sessions, turnsOf } from "./index.js"
import type { ModelScript } from "./index.js"

/*
 * Testing a host, as a test: the host's program names its model and its
 * store by contract alone, so a test runs the same program over a model
 * that follows a script and a journal kept in the process, then reads the
 * journal as its turns (`turnsOf`) and checks what the program did.
 * Nothing of the program is replaced by a stand-in of the test's own.
 * `docs/kernel.md` quotes the program and the test.
 */

// #region program
// The host's program: one tool, and one turn. It asks for its model, its memory and its sessions by contract.
const Add = Tool.make("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
})
const tools = Toolkit.make(Add)
const toolsLive = tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

const answer = (conversation: SessionId, message: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const memory = yield* Memory
      const toolkit = yield* tools
      const session = yield* (yield* Sessions).open(conversation)
      yield* session.append(userMessage(message))
      for (let step = 1; step <= 4; step++) {
        const prompt = Prompt.make([{ role: "system", content: "Use a tool when it helps." }, ...(yield* memory.context(session))])
        const said = yield* modelAnswer(model.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
        if (said.toolCalls.length === 0) return said.text
        for (const call of said.toolCalls) yield* callTool(toolkit, call, session)
      }
      return "I stopped after 4 steps."
    }),
  )
// #endregion program

// #region test
// The same program over a model that follows a script and a journal kept in the process: what it did, as turns.
const turnsAfter = (script: ModelScript, messages: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { model } = yield* scriptedModel(script)
    const store = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))
    return yield* Effect.gen(function* () {
      const all = yield* Sessions
      const conversation = yield* all.create({ owner: "test" })
      // A turn that fails is a turn too: the test reads how it closed from the journal.
      yield* Effect.forEach(messages, (message) => Effect.exit(answer(conversation, message)), { concurrency: 1, discard: true })
      return turnsOf((yield* all.read(conversation)).events)
    }).pipe(Effect.provide(Layer.mergeAll(model, toolsLive, flatMemory, store)))
  })

test("a host's program under test: a sum is worked out by the tool, one call with the numbers asked, its result, then the answer", async () => {
  const [turn] = await Effect.runPromise(turnsAfter([
    { _tag: "Calls", pieces: [], calls: [{ name: "add", params: { a: 2, b: 3 } }] },
    { _tag: "Answers", pieces: ["It is 5."] },
  ], ["What is 2 + 3?"]))
  const calls = turn?.steps.flatMap((step) => step.calls) ?? []
  expect(calls.map((call) => [call.name, call.input, Option.getOrNull(call.result)?.result])).toEqual([["add", { a: 2, b: 3 }, 5]])
  expect(Option.getOrNull(turn?.answer ?? Option.none())).toBe("It is 5.")
  expect(Option.getOrNull(turn?.closed ?? Option.none())?.outcome).toEqual({ _tag: "Completed" })
})
// #endregion test

describe("a host's program under test", () => {
  test("each message is a turn of its own, with the message it took; a turn the model failed in has no answer and says why it closed", async () => {
    const turns = await Effect.runPromise(turnsAfter([{ _tag: "Answers", pieces: ["Hello."] }, { _tag: "Fails" }], ["Hi.", "Still there?"]))
    expect(turns.map((turn) => [Number(turn.turn), turn.messages.map((message) => message.text), Option.getOrNull(turn.answer)])).toEqual([
      [1, ["Hi."], "Hello."],
      [2, ["Still there?"], null],
    ])
    const closed = turns.map((turn) => Option.getOrNull(turn.closed)?.outcome)
    expect(closed[0]).toEqual({ _tag: "Completed" })
    expect(closed[1]?._tag).toBe("Failed")
  })

  test("a call the model got wrong is a failed result the check names by its record; the turn goes on to an answer", async () => {
    const [turn] = await Effect.runPromise(turnsAfter([
      { _tag: "Calls", pieces: [], calls: [{ name: "add", params: { a: "two", b: 3 } }] },
      { _tag: "Answers", pieces: ["I could not add those."] },
    ], ["What is two + 3?"]))
    const failed = (turn?.steps ?? []).flatMap((step) => step.calls).flatMap((call) => Option.match(call.result, {
      onNone: () => [],
      onSome: (result) => (result.isFailure ? [`${call.name} failed, record #${result.seq}`] : []),
    }))
    expect(failed).toEqual(["add failed, record #4"])
    expect(Option.getOrNull(turn?.answer ?? Option.none())).toBe("I could not add those.")
    // Every record of the turn is there for a check that reads further: here, their names in order.
    expect(turn?.records.map((record) => String(record.name))).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result",
      "conversation.assistant.message", "core.session.turn.ended",
    ])
  })
})
