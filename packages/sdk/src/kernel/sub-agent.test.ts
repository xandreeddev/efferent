import { describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import type { JournalStorageError, OpenSession, SessionId } from "@xandreed/core/kernel"
import { callTool, CurrentTurn, flatMemory, inProcessJournal, Memory, modelAnswer, scriptedModel, sessions } from "./index.js"
import { Helper } from "./testing.port.js"

/*
 * A sub-agent, as a test (ADR 0006): a turn hands a task to an agent of its
 * own, which works in a session of its own, a child of the turn's, and gets
 * back only its answer. Nothing in the kernel is new for it: a session made
 * with a parent, a turn opened in it while the parent's is open, and a tool
 * whose result names the child. `docs/kernel.md` quotes the helper.
 */

/** One turn of an agent in any session: the tools lesson's loop, with its system text and tools given. */
const agentTurn = <Tools extends Record<string, Tool.Any>>(system: string, toolkit: Toolkit.WithHandler<Tools>) =>
  (session: OpenSession, message: string) => Effect.gen(function* () {
    const memory = yield* Memory
    const model = yield* LanguageModel.LanguageModel
    yield* session.append(userMessage(message))
    for (let step = 1; step <= 4; step++) {
      const prompt = Prompt.make([{ role: "system", content: system }, ...(yield* memory.context(session))])
      const answer = yield* modelAnswer(model.streamText({ prompt, toolkit, disableToolCallResolution: true, toolCallValidation: "deferred" }), session)
      if (answer.toolCalls.length === 0) return answer.text
      for (const call of answer.toolCalls) {
        yield* callTool(toolkit, call, session) // the call runs in this turn (ADR 0007), and its result is stored
      }
    }
    return "I stopped."
  })

const Add = Tool.make("add", { description: "Add two numbers.", parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }), success: Schema.Number })
const helperTools = Toolkit.make(Add)
const helperToolsLive = helperTools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

// #region helper
// The tool the parent's model calls. Its result names the helper's session: the stored link from the call to the child.
const Delegate = Tool.make("delegate", {
  description: "Hand a task to a helper. It works in a session of its own and returns only its answer.",
  parameters: Schema.Struct({ task: Schema.String }),
  success: Schema.Struct({ answer: Schema.String, session: Schema.String }),
  failure: Schema.String,
  failureMode: "return",
  dependencies: [CurrentTurn], // its handler reaches the turn the call runs in
})

// How deep helpers may go: the loop's step limit bounds one turn, not helpers calling helpers.
const MAX_DEPTH = 2

// The helper: an agent of its own, with its own system text and tools, in a session whose parent is the caller's.
const helperLive = Layer.effect(Helper, Effect.gen(function* () {
  const sessionsOf = yield* Sessions
  const toolkit = yield* helperTools
  const services = yield* Effect.context<Memory | LanguageModel.LanguageModel>()
  const helper = agentTurn("You are a helper. Answer the task in one sentence.", toolkit)
  // How many helpers deep a session is: its parents, read from the store, up to the root.
  const depthOf = (id: SessionId): Effect.Effect<number, JournalStorageError> => Effect.flatMap(sessionsOf.read(id), (journal) =>
    journal.header.parent === undefined ? Effect.succeed(0) : Effect.map(depthOf(journal.header.parent), (depth) => depth + 1))
  return Helper.of({
    ask: (task) => Effect.scoped(Effect.gen(function* () {
      const caller = yield* CurrentTurn // the turn the delegate call runs in: the chat's, or a helper's
      if ((yield* depthOf(caller.id)) >= MAX_DEPTH) return yield* Effect.fail("a helper this deep may not hand work further down")
      const session = yield* sessionsOf.create({ owner: "helper", parent: caller.id })
      const answer = yield* helper(yield* sessionsOf.open(session), task) // a turn of its own, while the caller's is open
      return { answer, session }
    })).pipe(Effect.provide(services), Effect.mapError((error) => (typeof error === "string" ? error : error.message))),
  })
}))
// #endregion helper

describe("a sub-agent: a session of its own", () => {
  test("the helper works in a child session; the parent's journal holds the call and its result, and nothing of the helper's work", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, calls } = yield* scriptedModel([
        { _tag: "Calls", pieces: ["I'll ask a helper."], calls: [{ name: "delegate", params: { task: "What is 2 + 3?" } }] },
        { _tag: "Calls", pieces: [], calls: [{ name: "add", params: { a: 2, b: 3 } }] },
        { _tag: "Answers", pieces: ["It is 5."] },
        { _tag: "Answers", pieces: ["The helper says 5."] },
      ])
      const tools = Toolkit.merge(helperTools, Toolkit.make(Delegate))
      const stack = Layer.mergeAll(helperToolsLive, helperLive.pipe(Layer.provide(helperToolsLive))).pipe(
        Layer.provideMerge(flatMemory),
        Layer.provideMerge(sessions()),
        Layer.provideMerge(inProcessJournal()),
        Layer.provideMerge(kernel()),
        Layer.provideMerge(model),
      )
      return yield* Effect.gen(function* () {
        const sessionsOf = yield* Sessions
        const helper = yield* Helper
        const parent = yield* sessionsOf.create({ owner: "learner" })
        const delegateLive = Toolkit.make(Delegate).toLayer({ delegate: ({ task }) => helper.ask(task) })
        const reply = yield* Effect.scoped(Effect.gen(function* () {
          const toolkit = yield* tools
          return yield* agentTurn("You are a helpful assistant.", toolkit)(yield* sessionsOf.open(parent), "Ask a helper: 2 + 3?")
        })).pipe(Effect.provide(delegateLive))
        const parentJournal = yield* sessionsOf.read(parent)
        const childId = parentJournal.events.flatMap((event) => (event.message?._tag === "ToolResult" ? [(event.message.result as { readonly session: SessionId }).session] : []))[0]!
        const childJournal = yield* sessionsOf.read(childId)
        return { reply, parent, parentJournal, childJournal, prompts: yield* calls }
      }).pipe(Effect.provide(stack))
    })))

    expect(result.reply).toBe("The helper says 5.")
    // The child names the parent: the session it continues.
    expect(result.childJournal.header.parent).toBe(result.parent)
    // The parent's journal: its turn, the call, the result naming the child, the answer. None of the helper's work.
    expect(result.parentJournal.events.map((event): string => event.name)).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result",
      "conversation.assistant.message", "core.session.turn.ended",
    ])
    // The child's journal: a whole turn of its own, its tool call and result included.
    expect(result.childJournal.events.map((event): string => event.name)).toEqual([
      "core.session.turn.started", "conversation.user.message", "conversation.assistant.message", "conversation.tool.result",
      "conversation.assistant.message", "core.session.turn.ended",
    ])
    // What each model call was shown: the helper only its task; the parent, after, only the call and its result.
    const shown = result.prompts.map((prompt) => prompt.map((message) => `${message.role}: ${message.text}`))
    expect(shown[1]).toEqual(["system: You are a helper. Answer the task in one sentence.", "user: What is 2 + 3?"])
    expect(shown[3]?.slice(1, 3)).toEqual(["user: Ask a helper: 2 + 3?", "assistant: I'll ask a helper.delegate({\"task\":\"What is 2 + 3?\"})"])
    expect(shown[3]?.at(-1)).toMatch(/^tool: → \{"answer":"It is 5\.","session":"[0-9a-f-]+"\}$/)
    expect(shown[3]?.length).toBe(4)
  })

  test("a helper cannot work in the caller's own session: its turn is open, so the helper's is refused", async () => {
    const base = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))
    const caught = Effect.gen(function* () {
      const sessionsOf = yield* Sessions
      const parent = yield* sessionsOf.create({ owner: "learner" })
      yield* sessionsOf.open(parent) // the caller's turn, open
      return yield* Effect.flip(Effect.scoped(sessionsOf.open(parent))) // the helper's, in the same session
    })
    const refused = await Effect.runPromise(Effect.scoped(caught).pipe(Effect.provide(base)))
    expect(refused._tag === "SessionRefused" && "reason" in refused ? refused.reason : refused._tag).toBe("SessionBusy")
  })

  test("a helper asked from a helper's turn works under that helper; the depth limit, read from the parent chain, refuses the next one down", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* scriptedModel([{ _tag: "Answers", pieces: ["Done."] }, { _tag: "Answers", pieces: ["Done too."] }])
      const stack = Layer.mergeAll(helperToolsLive, helperLive.pipe(Layer.provide(helperToolsLive))).pipe(
        Layer.provideMerge(flatMemory), Layer.provideMerge(sessions()), Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()), Layer.provideMerge(model),
      )
      return yield* Effect.gen(function* () {
        const sessionsOf = yield* Sessions
        const helper = yield* Helper
        // Ask from inside a session's open turn, as a delegate call made in it would.
        const askFrom = (id: SessionId, task: string) => Effect.scoped(Effect.flatMap(sessionsOf.open(id), (turn) => helper.ask(task).pipe(Effect.provideService(CurrentTurn, turn))))
        const chat = yield* sessionsOf.create({ owner: "learner" })
        const firstSession = (yield* askFrom(chat, "a task")).session as SessionId
        const secondSession = (yield* askFrom(firstSession, "a smaller task")).session as SessionId
        const third = yield* Effect.flip(askFrom(secondSession, "smaller still"))
        return {
          firstParent: (yield* sessionsOf.read(firstSession)).header.parent, chat,
          secondParent: (yield* sessionsOf.read(secondSession)).header.parent, firstSession,
          third,
        }
      }).pipe(Effect.provide(stack))
    })))
    expect(result.firstParent).toBe(result.chat)
    expect(result.secondParent).toBe(result.firstSession)
    expect(result.third).toBe("a helper this deep may not hand work further down")
  })
})
