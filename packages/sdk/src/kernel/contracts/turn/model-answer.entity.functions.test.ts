import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect"
import type { Scope } from "effect"
import { Response } from "effect/ai"
import { Core, kernel, liveEvent, Sessions, userMessage } from "@xandreed/core/kernel"
import type { OpenSession } from "@xandreed/core/kernel"
import { inProcessJournal, sessions } from "../../index.js"
import { CurrentTurn } from "./current-turn.port.js"
import { modelAnswer } from "./model-answer.entity.functions.js"

const usage = { inputTokens: { total: 40, uncached: 10, cacheRead: 30, cacheWrite: 0 }, outputTokens: { total: 7, text: 7, reasoning: 0 } }
const piece = (delta: string) => Response.makePart("text-delta", { id: "t", delta })
const asks = (id: string, name: string, params: unknown) => Response.makePart("tool-call", { id, name, params, providerExecuted: false })
const finish = Response.makePart("finish", { reason: "stop", usage, response: undefined })
const from = (model: string) => Response.makePart("response-metadata", { id: "r", modelId: model, timestamp: undefined, request: undefined })

const stack = sessions().pipe(Layer.provideMerge(inProcessJournal()), Layer.provideMerge(kernel()))

/** Run `body` in an open turn of a new session, and give what it gave with the turn's records after the user's message. */
const inTurn = <A, E>(body: (session: OpenSession) => Effect.Effect<A, E, Core | Sessions | Scope.Scope>) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const all = yield* Sessions
  const id = yield* all.create({ owner: "test" })
  const session = yield* all.open(id)
  yield* session.append(userMessage("go"))
  const result = yield* Effect.exit(body(session))
  return { result, stored: (yield* session.journal).slice(2).map((event) => ({ name: String(event.name), data: event.data, message: event.message })) }
})).pipe(Effect.provide(stack)))

describe("modelAnswer", () => {
  test("stores one answer, with its text, the calls it made, what it cost and the model that answered, and gives it back", async () => {
    const heard: Array<string> = []
    const { result, stored } = await inTurn((session) => modelAnswer(
      Stream.fromIterable<Response.AnyPart>([from("echo-1"), piece("Let me "), piece("add."), asks("call-1", "add", { a: 2, b: 3 }), finish]),
      session,
      { onText: (text) => Effect.sync(() => { heard.push(text) }) },
    ))
    expect(result).toEqual(Exit.succeed({
      text: "Let me add.",
      toolCalls: [{ id: "call-1", name: "add", params: { a: 2, b: 3 } }],
      usage: Option.some({ inputTokens: 40, outputTokens: 7, cachedInputTokens: 30 }),
      model: Option.some("echo-1"),
    }))
    // Each piece was handed on as it arrived, in order.
    expect(heard).toEqual(["Let me ", "add."])
    expect<unknown>(stored).toEqual([{
      name: "conversation.assistant.message",
      data: { usage: { inputTokens: 40, outputTokens: 7, cachedInputTokens: 30 }, model: "echo-1" },
      message: { _tag: "Assistant", text: "Let me add.", toolCalls: [{ id: "call-1", name: "add", input: { a: 2, b: 3 } }] },
    }])
  })

  test("an answer whose provider reported neither a cost nor a model is stored without them", async () => {
    const { result, stored } = await inTurn((session) => modelAnswer(Stream.fromIterable<Response.AnyPart>([piece("Hi.")]), session))
    expect(result).toEqual(Exit.succeed({ text: "Hi.", toolCalls: [], usage: Option.none(), model: Option.none() }))
    expect(stored).toEqual([{ name: "conversation.assistant.message", data: {}, message: { _tag: "Assistant", text: "Hi.", toolCalls: [] } }])
  })

  test("a stream that reports an error fails with the error's own message, after its pieces were handed on, and stores nothing", async () => {
    const heard: Array<string> = []
    const broken = (error: unknown) => inTurn((session) => modelAnswer(
      Stream.fromIterable<Response.AnyPart>([piece("Half an ans"), Response.makePart("error", { error }), piece("wer."), finish]),
      session,
      { onText: (text) => Effect.sync(() => { heard.push(text) }) },
    ))
    const told = async (error: unknown) => {
      const { result, stored } = await broken(error)
      return { failure: Exit.isFailure(result) ? Option.map(Cause.findErrorOption(result.cause), (failed) => `${failed._tag}: ${failed.message}`) : Option.none(), stored }
    }
    expect(await told(new Error("the provider is overloaded"))).toEqual({ failure: Option.some("ModelAnswerFailed: the provider is overloaded"), stored: [] })
    expect(await told("rate limited")).toEqual({ failure: Option.some("ModelAnswerFailed: rate limited"), stored: [] })
    // An error that says nothing of itself: the failure says what happened.
    expect(await told({ status: 529 })).toEqual({ failure: Option.some("ModelAnswerFailed: the model's stream reported an error"), stored: [] })
    expect(heard).toEqual(["Half an ans", "Half an ans", "Half an ans"])
  })

  test("a failure of the stream itself is the caller's, as it came, and stores nothing", async () => {
    class Down extends Schema.TaggedError<Down>()("Down", { message: Schema.String }) {}
    const { result, stored } = await inTurn((session) => modelAnswer(Stream.concat(Stream.fromIterable<Response.AnyPart>([piece("Half")]), Stream.fail(new Down({ message: "no route" }))), session))
    expect(Exit.isFailure(result) ? Option.map(Cause.findErrorOption(result.cause), (failed) => failed._tag) : Option.none()).toEqual(Option.some("Down"))
    expect(stored).toEqual([])
  })

  test("gives the stream its turn: what runs while the model answers reads CurrentTurn, each call its own", async () => {
    // A wrapper of a model, as a stream that asks which turn it is answering for before it answers.
    const wrapped = Stream.unwrap(Effect.gen(function* () {
      const turn = yield* CurrentTurn
      yield* Effect.yieldNow
      return Stream.fromIterable<Response.AnyPart>([piece(`for ${turn.id} turn ${turn.turn}`)])
    }))
    const answers = await Effect.runPromise(Effect.gen(function* () {
      const all = yield* Sessions
      const ids = yield* Effect.forEach(["a", "b"], () => all.create({ owner: "test" }), { concurrency: 1 })
      // Two sessions answer at once: each stream reads the turn of the call it is in, not the other's.
      const texts = yield* Effect.forEach(ids, (id) => all.turn(id, (session) => Effect.map(modelAnswer(wrapped, session), (answer) => answer.text)), { concurrency: 2 })
      return { texts, expected: ids.map((id) => `for ${id} turn 1`) }
    }).pipe(Effect.provide(stack)))
    expect(answers.texts).toEqual(answers.expected)
  })

  test("a write that fails in what runs while the model answers is a defect of the call: the turn fails, and no answer is stored", async () => {
    const said = liveEvent("wrapper", "said", { tags: ["trace"], data: Schema.Struct({}) })
    class Deaf extends Schema.TaggedError<Deaf>()("Deaf", { message: Schema.String }) {}
    const wrapped = Stream.unwrap(Effect.gen(function* () {
      const turn = yield* CurrentTurn
      yield* turn.publish(said, {})
      return Stream.fromIterable<Response.AnyPart>([piece("never read")])
    }))
    const { result, stored } = await inTurn((session) => Effect.gen(function* () {
      const core = yield* Core
      yield* core.on(said, () => Effect.fail(new Deaf({ message: "the watcher broke" })), { name: "watcher", wait: true })
      const reached = yield* Ref.make(false)
      yield* modelAnswer(wrapped, session)
      yield* Ref.set(reached, true)
    }))
    expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(true)
    expect(stored).toEqual([])
  })
})
