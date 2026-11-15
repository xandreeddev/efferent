import { describe, expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { assistantMessage, kernel, Sessions, TurnNumber, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { Approval, approve, callTool, CurrentTurn, flatMemory, inProcessJournal, Memory, modelAnswer, ReadResult, readResult, scriptedModel, sessions, summarizedEvent, Summarizer, summaryMemory, turnsOf, windowMemory } from "./index.js"
import type { Decision, ModelScript } from "./index.js"

/*
 * Branches (ADR 0016), as a test: a host continues a conversation from an earlier turn and keeps the original. A
 * branch is a session whose journal starts as a copy of the other's, up to a closed turn, so every part that reads
 * a journal reads a branch unchanged. `docs/kernel.md` quotes the host's branch and the test.
 */

const Add = Tool.make("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
})
const tools = Toolkit.make(Add)
const toolsLive = tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

/** The host's turn: one message, the model asked until it answers, each call it asks for run. */
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

const store = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))

// #region branch
// A conversation of two turns, then a branch cut after the first: asked the second question another way.
// The original keeps its second turn; the branch has its own.
const branched = Effect.gen(function* () {
  const all = yield* Sessions
  const conversation = yield* all.create({ owner: "host" })
  yield* answer(conversation, "What is 2 + 3?")
  yield* answer(conversation, "Thanks.")
  const branch = yield* all.fork(conversation, { through: TurnNumber.make(1) })
  yield* answer(branch, "And 2 + 4?")
  return { original: yield* all.read(conversation), branch: yield* all.read(branch) }
})
// #endregion branch

const script: ModelScript = [
  { _tag: "Calls", pieces: [], calls: [{ name: "add", params: { a: 2, b: 3 } }] },
  { _tag: "Answers", pieces: ["It is 5."] },
  { _tag: "Answers", pieces: ["You are welcome."] },
  { _tag: "Calls", pieces: [], calls: [{ name: "add", params: { a: 2, b: 4 } }] },
  { _tag: "Answers", pieces: ["It is 6."] },
]

/** What a turn's user messages and answer were, as `turnsOf` reads them. */
const told = (events: Parameters<typeof turnsOf>[0]) =>
  turnsOf(events).map((turn) => [Number(turn.turn), turn.messages.map((message) => message.text), Option.getOrNull(turn.answer)])

// #region test
test("a branch starts as the conversation up to the turn it was cut after, and goes on alone", async () => {
  const { model, calls } = await Effect.runPromise(scriptedModel(script))
  const ran = await Effect.runPromise(Effect.flatMap(branched, (both) => Effect.map(calls, (sent) => ({ ...both, sent })))
    .pipe(Effect.provide(Layer.mergeAll(model, toolsLive, flatMemory, store))))
  expect(told(ran.original.events)).toEqual([[1, ["What is 2 + 3?"], "It is 5."], [2, ["Thanks."], "You are welcome."]])
  expect(told(ran.branch.events)).toEqual([[1, ["What is 2 + 3?"], "It is 5."], [2, ["And 2 + 4?"], "It is 6."]])
  // The branch's first turn is the original's, record for record, as it was stored.
  const firstTurn = ran.original.events.filter((event) => event.turn === 1)
  expect(ran.branch.events.filter((event) => event.turn === 1)).toEqual(firstTurn)
  expect([ran.branch.header.branch?.of, ran.branch.header.branch?.through]).toEqual([ran.original.header.id, firstTurn.at(-1)?.seq])
  // Asked on the branch, the model was sent the first turn and the new question: never "Thanks.".
  expect(ran.sent.at(-2)?.map((message) => message.text)).toEqual(["Use a tool when it helps.", "What is 2 + 3?", 'add({"a":2,"b":3})', "→ 5", "It is 5.", "And 2 + 4?"])
})
// #endregion test

describe("every part reads a branch as it read the conversation at the cut", () => {
  /** Three turns of a user's message and an answer, each long enough for a small budget to fold. */
  const conversation = Effect.gen(function* () {
    const all = yield* Sessions
    const id = yield* all.create({ owner: "host" })
    yield* Effect.forEach([1, 2, 3], (turn) => all.turn(id, (session) => Effect.andThen(
      session.append(userMessage(`Question ${turn}: ${"a long question ".repeat(10)}`)),
      session.append(assistantMessage(`Answer ${turn}: ${"a long answer ".repeat(10)}`)),
    )), { concurrency: 1, discard: true })
    return id
  })

  /** The context a memory builds for the next turn of `id`, in a turn opened for it and closed again. */
  const contextOf = (id: SessionId) => Effect.gen(function* () {
    const memory = yield* Memory
    return yield* (yield* Sessions).turn(id, (session) => Effect.andThen(session.append(userMessage("And now?")), memory.context(session)))
  })

  const summarizer = Layer.succeed(Summarizer, Summarizer.of({ summarize: ({ messages }) => Effect.succeed(`${messages.length} messages folded`) }))
  const memories: ReadonlyArray<readonly [string, Layer.Layer<Memory, unknown>]> = [
    ["flat", flatMemory],
    ["window", windowMemory({ budgetTokens: 120 })],
    ["summary", summaryMemory({ budgetTokens: 120 }).pipe(Layer.provide(summarizer))],
  ]

  for (const [name, memory] of memories) {
    test(`the ${name} memory: the branch's next context is the one the conversation's next turn got at the cut`, async () => {
      const [original, branch] = await Effect.runPromise(Effect.gen(function* () {
        const all = yield* Sessions
        const id = yield* conversation
        // The conversation's next turn, then a branch cut before it: the branch's next turn is the same turn.
        const before = yield* contextOf(id)
        const copy = yield* all.fork(id, { through: TurnNumber.make(3) })
        return [before, yield* contextOf(copy)] as const
      }).pipe(Effect.provide(Layer.provideMerge(memory, store))))
      expect(branch).toEqual(original)
      expect(original.length).toBeGreaterThan(0)
    })
  }

  test("a summary stored before the cut is the branch's: its next context starts with it, and the summarizer is not asked again", async () => {
    const asked = await Effect.runPromise(Ref.make(0))
    const counting = Layer.succeed(Summarizer, Summarizer.of({ summarize: ({ messages }) => Effect.as(Ref.update(asked, (count) => count + 1), `${messages.length} messages folded`) }))
    const ran = await Effect.runPromise(Effect.gen(function* () {
      const all = yield* Sessions
      const id = yield* conversation
      // Turn 4 compacts, and its summary is stored in it; the branch is cut after it.
      yield* contextOf(id)
      const summarized = yield* Ref.get(asked)
      const copy = yield* all.fork(id, { through: TurnNumber.make(4) })
      const branched = yield* contextOf(copy)
      const original = yield* contextOf(id)
      const held = (yield* all.read(copy)).events.filter((event) => event.name === summarizedEvent.name).length
      return { summarized, after: yield* Ref.get(asked), held, same: JSON.stringify(branched) === JSON.stringify(original) }
    }).pipe(Effect.provide(Layer.provideMerge(summaryMemory({ budgetTokens: 120 }).pipe(Layer.provide(counting)), store))))
    expect(ran).toEqual({ summarized: 1, after: 1, held: 1, same: true })
  })

  test("an approval given for good before the cut holds on the branch: its tool acts there with nobody asked", async () => {
    const Act = Tool.make("act", { description: "Act.", success: Schema.String, failure: Schema.String, failureMode: "return", dependencies: [Approval, CurrentTurn] })
    const acting = Toolkit.make(Act)
    const handlers = acting.toLayer({ act: () => Effect.as(approve({ action: "things.act", detail: "Act once." }), "acted") })
    const asked = await Effect.runPromise(Ref.make(0))
    // The person says "always" once, and no after that: a second question would be refused.
    const person = Layer.succeed(Approval, Approval.of({
      ask: () => Effect.map(Ref.updateAndGet(asked, (count) => count + 1), (count): Decision => (count === 1 ? { _tag: "ApprovedAlways" } : { _tag: "Refused" })),
    }))
    const results = await Effect.runPromise(Effect.gen(function* () {
      const all = yield* Sessions
      const toolkit = yield* acting
      const act = (id: SessionId, call: string) => all.turn(id, (session) => Effect.andThen(
        session.append(assistantMessage("", { toolCalls: [{ id: call, name: "act", params: {} }] })),
        callTool(toolkit, { id: call, name: "act", params: {} }, session),
      ))
      const id = yield* all.create({ owner: "host" })
      yield* act(id, "c1")
      const copy = yield* all.fork(id, { through: TurnNumber.make(1) })
      return yield* act(copy, "c2")
    }).pipe(Effect.provide(Layer.mergeAll(handlers, person, store))))
    expect([results.message?._tag === "ToolResult" ? results.message.result : null, await Effect.runPromise(Ref.get(asked))]).toEqual(["acted", 1])
  })

  test("a long result read on through a branch: readResult finds it at the place it had in the conversation", async () => {
    const LongTools = Toolkit.make(Tool.make("lookup", { description: "Look up.", parameters: Schema.Struct({}), success: Schema.String }), ReadResult)
    const article = Array.from({ length: 30 }, (_, line) => `Line ${line + 1} of the article.`).join("\n")
    const handlers = LongTools.toLayer({ lookup: () => Effect.succeed(article), readResult })
    const [original, branch] = await Effect.runPromise(Effect.gen(function* () {
      const all = yield* Sessions
      const toolkit = yield* LongTools
      const id = yield* all.create({ owner: "host" })
      const stored = yield* all.turn(id, (session) => Effect.andThen(
        session.append(assistantMessage("", { toolCalls: [{ id: "c1", name: "lookup", params: {} }] })),
        callTool(toolkit, { id: "c1", name: "lookup", params: {} }, session),
      ))
      const page = (from: SessionId) => all.turn(from, (session) => Effect.andThen(
        session.append(assistantMessage("", { toolCalls: [{ id: "c2", name: "readResult", params: { result: stored.seq, from: 40, length: 60 } }] })),
        callTool(toolkit, { id: "c2", name: "readResult", params: { result: stored.seq, from: 40, length: 60 } }, session),
      ))
      const copy = yield* all.fork(id, { through: TurnNumber.make(1) })
      return [yield* page(id), yield* page(copy)] as const
    }).pipe(Effect.provide(Layer.mergeAll(handlers, store))))
    expect(branch.message).toEqual(original.message)
    expect(branch.message?._tag === "ToolResult" && branch.message.isFailure).toBe(false)
  })
})
