import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { callTool, CurrentTurn, flatMemory, inProcessJournal, Memory, scriptedModel, sessions } from "./index.js"
import type { ModelScript } from "./index.js"

/*
 * A host's turn that uses tools, as a test: the turn is a loop over steps.
 * The tools are Effect AI's own `Toolkit`, declared in code like the system
 * text and never stored; the turn offers them to the model, runs each call
 * the model makes through their handlers, stores the call and its result,
 * and asks again, until the model answers without a call or the step limit
 * is reached. `docs/kernel.md` quotes the tools and the turn.
 */

// #region tools
// The tools: what each does, what it takes, and what it returns. Code, offered in every call, never stored.
const Add = Tool.make("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
})
const Divide = Tool.make("divide", {
  description: "Divide a by b.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
  failure: Schema.String,
  // A failure is returned to the model as the tool's answer, not raised.
  failureMode: "return",
})
const tools = Toolkit.make(Add, Divide)

// What each tool does when it is called.
const toolsLive = tools.toLayer({
  add: ({ a, b }) => Effect.succeed(a + b),
  divide: ({ a, b }) => (b === 0 ? Effect.fail("cannot divide by zero") : Effect.succeed(a / b)),
})
// #endregion tools

const MAX_STEPS = 4

const run = (script: ModelScript, messages: ReadonlyArray<string>) => Effect.gen(function* () {
  const { model, calls } = yield* scriptedModel(script)
  const said = yield* Ref.make<ReadonlyArray<string>>([])
  const show = (line: string) => Ref.update(said, (all) => [...all, line])

  // #region turn
  // One turn: the model answers, or asks for tools; their results are stored, and the model is asked again.
  const turn = (conversation: SessionId, message: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* Sessions
        const memory = yield* Memory
        const model = yield* LanguageModel.LanguageModel
        const toolkit = yield* tools

        const session = yield* sessions.open(conversation)
        yield* session.append(userMessage(message))

        for (let step = 1; step <= MAX_STEPS; step++) {
          const history = yield* memory.context(session)
          const prompt = Prompt.make([{ role: "system", content: "Use a tool when it helps." }, ...history])

          // Offer the tools, but run none: the turn runs the calls itself. A call the model got wrong comes through
          // as it is ("deferred"), so it can be answered as a failure.
          const parts = yield* model.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" }).pipe(
            Stream.tap((part) => (part.type === "error" ? Effect.fail(part.error) : Effect.void)),
            Stream.runCollect,
          )
          const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : [])).join("")
          const calls = parts.flatMap((part) => (part.type === "tool-call" ? [part] : []))

          // Store the model's answer with the calls it made, then run each call and store its result.
          yield* session.append(assistantMessage(text, { toolCalls: calls }))
          if (calls.length === 0) return text
          // Each call runs in this turn (a tool that declares CurrentTurn reaches the session from its handler), and its
          // result is stored. A tool that fails, or a call the model got wrong, is an answer too: the model reads it and goes on.
          for (const call of calls) {
            yield* session.append(yield* callTool(toolkit, call, session))
          }
        }
        return `I stopped after ${MAX_STEPS} steps.`
      }),
    )
  // #endregion turn

  const journal = yield* Effect.gen(function* () {
    const all = yield* Sessions
    const conversation = yield* all.create({ owner: "test" })
    yield* Effect.forEach(messages, (message) => Effect.flatMap(turn(conversation, message), show), { concurrency: 1, discard: true })
    return (yield* all.read(conversation)).events
  }).pipe(Effect.provide(Layer.merge(model, toolsLive)))
  return { said: yield* Ref.get(said), calls: yield* calls, journal }
})

const stack = Layer.mergeAll(flatMemory, sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel())))

describe("a host's turn with tools", () => {
  test("the model asks for a tool, the turn stores the call and its result, and the model answers from it", async () => {
    const result = await Effect.runPromise(run([
      { _tag: "Calls", pieces: ["Let me add."], calls: [{ name: "add", params: { a: 2, b: 3 } }] },
      { _tag: "Answers", pieces: ["It is 5."] },
    ], ["What is 2 + 3?"]).pipe(Effect.provide(stack)))
    expect(result.said).toEqual(["It is 5."])
    expect(result.calls[1]).toEqual([
      { role: "system", text: "Use a tool when it helps." },
      { role: "user", text: "What is 2 + 3?" },
      { role: "assistant", text: "Let me add.add({\"a\":2,\"b\":3})" },
      { role: "tool", text: "→ 5" },
    ])
    expect(result.journal.map((record) => String(record.name))).toEqual([
      "core.session.turn.started",
      "conversation.user.message",
      "conversation.assistant.message",
      "conversation.tool.result",
      "conversation.assistant.message",
      "core.session.turn.ended",
    ])
  })

  test("a tool's failure, an unknown tool and bad parameters are stored as failed results, and the turn goes on", async () => {
    const result = await Effect.runPromise(run([
      { _tag: "Calls", pieces: [], calls: [{ name: "divide", params: { a: 1, b: 0 } }, { name: "nope", params: {} }, { name: "add", params: { a: "two" } }] },
      { _tag: "Answers", pieces: ["None of that worked."] },
    ], ["Try things."]).pipe(Effect.provide(stack)))
    expect(result.said).toEqual(["None of that worked."])
    const failures = result.journal.flatMap((record) => (record.message?._tag === "ToolResult" ? [[record.message.name, record.message.isFailure]] : []))
    expect(failures).toEqual([["divide", true], ["nope", true], ["add", true]])
    // The model reads each failure as the answer to its call.
    expect(result.calls[1]?.slice(-3).map((message) => message.text)).toEqual([
      "→ failed: \"cannot divide by zero\"",
      "→ failed: \"Toolkit.nope.handle: Tool 'nope' not found. Available tools: add, divide\"",
      "→ failed: \"Toolkit.add.handle: Invalid parameters for tool 'add': Expected number\\n  at [\\\"a\\\"]\"",
    ])
  })

  test("a model that keeps asking stops at the step limit, its last results stored", async () => {
    const result = await Effect.runPromise(run([
      { _tag: "Calls", pieces: [], calls: [{ name: "add", params: { a: 1, b: 1 } }] },
    ], ["Count forever."]).pipe(Effect.provide(stack)))
    expect(result.said).toEqual([`I stopped after ${MAX_STEPS} steps.`])
    expect(result.calls).toHaveLength(MAX_STEPS)
    expect(result.journal.filter((record) => record.name === "conversation.tool.result")).toHaveLength(MAX_STEPS)
  })
})
