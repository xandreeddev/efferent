import { describe, expect, test } from "bun:test"
import { Cause, Effect, ExecutionPlan, Exit, Layer, Option, Schedule, Schema } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import { Core, kernel, Sessions, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { attemptEvent, callTool, flatMemory, inProcessJournal, Memory, modelAnswer, planned, retryable, scriptedModel, sessions, turnsOf } from "./index.js"
import type { ModelScript } from "./index.js"

/*
 * When the model fails, as a host writes it: the loop asks for its answer under a plan (Effect's `ExecutionPlan`),
 * whose steps each provide a model and say how often to try it and when. The kernel's `planned` adds the one rule
 * the plan does not hold: once a word of the answer was handed on, it is never made again. Each attempt is said
 * about the turn, live. `docs/kernel.md` quotes the plan, the loop and the test.
 */

const Add = Tool.make("add", {
  description: "Add two numbers.",
  parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  success: Schema.Number,
})
const tools = Toolkit.make(Add)
const toolsLive = tools.toLayer({ add: ({ a, b }) => Effect.succeed(a + b) })

/** Two scripted models, each failing or answering as its script says: the one the host prefers, and a spare. */
const modelsOf = (preferred: ModelScript, spare: ModelScript) =>
  Effect.all([scriptedModel(preferred), scriptedModel(spare)], { concurrency: 1 })

// #region plan
// The plan: try the preferred model up to three times while its failure is worth another try, a second apart;
// then hand the call to the spare, once.
const planOf = (preferred: Layer.Layer<LanguageModel.LanguageModel>, spare: Layer.Layer<LanguageModel.LanguageModel>) =>
  ExecutionPlan.make(
    { provide: preferred, attempts: 3, schedule: Schedule.spaced("1 second"), while: retryable },
    { provide: spare },
  )
// #endregion plan

type Plan = ReturnType<typeof planOf>

// #region loop
// The loop asks for its answer under the plan: the model it reads is whichever the plan's step provides.
const answer = (plan: Plan, conversation: SessionId, message: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const memory = yield* Memory
      const toolkit = yield* tools
      const session = yield* (yield* Sessions).open(conversation)
      yield* session.append(userMessage(message))
      for (let step = 1; step <= 4; step++) {
        const prompt = Prompt.make([{ role: "system", content: "Use a tool when it helps." }, ...(yield* memory.context(session))])
        const stream = LanguageModel.streamText({ prompt, toolkit: tools, disableToolCallResolution: true, toolCallValidation: "deferred" })
        const said = yield* modelAnswer(stream.pipe(planned(plan)), session)
        if (said.toolCalls.length === 0) return said.text
        for (const call of said.toolCalls) yield* callTool(toolkit, call, session)
      }
      return "I stopped after 4 steps."
    }),
  )
// #endregion loop

const stack = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))

/** One message to the program under a plan: how the turn ended, what was said of each attempt, and the turn. */
const run = (preferred: ModelScript, spare: ModelScript, message: string) =>
  Effect.runPromise(Effect.gen(function* () {
    const [first, second] = yield* modelsOf(preferred, spare)
    return yield* Effect.scoped(Effect.gen(function* () {
      const all = yield* Sessions
      const attempts: Array<string> = []
      yield* (yield* Core).on(attemptEvent, (event) => Effect.sync(() => {
        attempts.push(`${event.data.outcome} ${event.data.step}.${event.data.attempt}`)
      }), { name: "test", wait: true })
      const conversation = yield* all.create({ owner: "test" })
      const ended = yield* Effect.exit(answer(planOf(first.model, second.model), conversation, message))
      const [turn] = turnsOf((yield* all.read(conversation)).events)
      return { ended, attempts, turn, asked: [(yield* first.calls).length, (yield* second.calls).length] }
    }))
  }).pipe(Effect.provide(Layer.mergeAll(toolsLive, flatMemory, stack))))

/** The turn's answer, or null. `planOf` waits a real second before a retry, so the two tests that retry take one. */
const answerOf = (turn: { readonly answer: Option.Option<string> } | undefined) => Option.getOrNull(turn?.answer ?? Option.none())

// #region test
test("a model that fails once with a failure worth another try is tried again, and its answer is the turn's", async () => {
  const ran = await run([{ _tag: "Fails", retryable: true }, { _tag: "Answers", pieces: ["It is 5."] }], [{ _tag: "Answers", pieces: ["Spare."] }], "What is 2 + 3?")
  expect(Exit.isSuccess(ran.ended)).toBe(true)
  expect(answerOf(ran.turn)).toBe("It is 5.")
  // Said live about the turn, never stored: the preferred model's first attempt failed, its second answered.
  expect(ran.attempts).toEqual(["started 0.1", "failed 0.1", "started 0.2", "succeeded 0.2"])
  expect(ran.asked).toEqual([2, 0])
})
// #endregion test

describe("a host's model calls under a plan", () => {
  test("a failure not worth another try hands the call to the spare at once", async () => {
    const ran = await run([{ _tag: "Fails" }], [{ _tag: "Answers", pieces: ["From the spare."] }], "Hi.")
    expect(answerOf(ran.turn)).toBe("From the spare.")
    expect(ran.attempts).toEqual(["started 0.1", "failed 0.1", "started 1.2", "succeeded 1.2"])
    expect(ran.asked).toEqual([1, 1])
  })

  test("an answer cut after a word is not made again: the turn fails with AnswerCut and stores no answer", async () => {
    const ran = await run([{ _tag: "Fails", retryable: true, pieces: ["It is "] }], [{ _tag: "Answers", pieces: ["Spare."] }], "What is 2 + 3?")
    expect(Exit.isFailure(ran.ended) ? Option.getOrNull(Cause.findErrorOption(ran.ended.cause)) : null).toMatchObject({ _tag: "AnswerCut" })
    expect(answerOf(ran.turn)).toBeNull()
    expect(ran.asked).toEqual([1, 0])
  })

  test("each model call of a turn has its own plan: a step that called a tool, then an answer that needed a retry", async () => {
    const ran = await run(
      [{ _tag: "Calls", pieces: [], calls: [{ name: "add", params: { a: 2, b: 3 } }] }, { _tag: "Fails", retryable: true }, { _tag: "Answers", pieces: ["It is 5."] }],
      [{ _tag: "Answers", pieces: ["Spare."] }],
      "What is 2 + 3?",
    )
    expect(answerOf(ran.turn)).toBe("It is 5.")
    expect(ran.turn?.steps.flatMap((step) => step.calls.map((call) => call.name))).toEqual(["add"])
    // The second call starts again at the plan's first step and counts its attempts from one.
    expect(ran.attempts).toEqual(["started 0.1", "succeeded 0.1", "started 0.1", "failed 0.1", "started 0.2", "succeeded 0.2"])
  })
})
