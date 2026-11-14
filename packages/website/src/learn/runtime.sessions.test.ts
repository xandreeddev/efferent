// The page's runtime when a program runs a turn in a second session inside the
// chat's turn, as a sub-agent does: every trace names its session, the chat
// stays busy until its own turn ends, and the Context board shows the chat's
// turn only. A program that calls the model by hand is placed by the last
// memory call; one that calls it through `modelAnswer` names its own turn,
// so two sessions calling at once are told apart.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Result, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { assistantMessage, Sessions, turnEndedEvent, userMessage } from "@xandreed/core/kernel"
import type { OpenSession } from "@xandreed/core/kernel"
import { flatMemory, Memory, modelAnswer } from "@xandreed/sdk/kernel"
import type { Lesson } from "./lesson.ts"
import { loadEcho } from "./models/mock.ts"
import { Chat } from "./page-chat.ts"
import { LessonRuntime } from "./runtime.ts"
import type { Trace } from "./runtime.ts"
import { emptyBoard, record, viewOf } from "./trace-model.ts"

const opened: Array<LessonRuntime> = []
afterEach(async () => { await Promise.all(opened.splice(0).map((runtime) => runtime.dispose())) })

/**
 * A program whose turn asks the model, runs a helper's whole turn in a session of its own (a child of the chat's),
 * then asks the model again and replies. Written here, not by a learner: the page's runtime is what is under test.
 */
const twoSessions: Lesson = {
  slug: "two-sessions", files: [], mainFile: "", chips: [], three: [], fill: [], controls: {}, experiments: {},
  evaluate: (_sources, parts) => {
    const program = Effect.gen(function* () {
      const chat = yield* Chat
      const sessions = yield* Sessions
      const memory = yield* Memory
      const model = yield* LanguageModel.LanguageModel
      const ask = (session: OpenSession) => Effect.gen(function* () {
        const history = yield* memory.context(session)
        const text = yield* model.streamText({ prompt: Prompt.make([{ role: "system", content: "Be brief." }, ...history]) }).pipe(
          Stream.runFold(() => "", (said, part) => (part.type === "text-delta" ? said + part.delta : said)),
        )
        yield* session.append(assistantMessage(text))
        return text
      })
      yield* Stream.runForEach(chat.messages, (message) => Effect.scoped(Effect.gen(function* () {
        const parent = yield* sessions.open(chat.session)
        yield* parent.append(userMessage(message))
        yield* ask(parent)
        const helper = yield* sessions.create({ owner: "helper", parent: chat.session })
        yield* Effect.scoped(Effect.gen(function* () {
          const child = yield* sessions.open(helper)
          yield* child.append(userMessage("a task of its own"))
          yield* ask(child)
        }))
        yield* chat.reply(yield* ask(parent))
      })))
    })
    const main = program.pipe(
      Effect.provide(parts.watchMemory(flatMemory)),
      Effect.provide(parts.chatOn(parts.pane)),
      Effect.provide(parts.sessions()),
      Effect.provide(parts.inProcessJournal()),
      Effect.provide(parts.kernel()),
      Effect.provide(parts.model),
    )
    return Result.succeed(main)
  },
}

/**
 * A program whose turn opens a turn in a second session too, builds both contexts, and only then calls the model
 * for both at once, each call through `modelAnswer`. The second session has had a turn before, so its turn is its
 * second while the chat's is its first.
 */
const atOnce: Lesson = {
  slug: "at-once", files: [], mainFile: "", chips: [], three: [], fill: [], controls: {}, experiments: {},
  evaluate: (_sources, parts) => {
    const program = Effect.gen(function* () {
      const chat = yield* Chat
      const sessions = yield* Sessions
      const memory = yield* Memory
      const model = yield* LanguageModel.LanguageModel
      const other = yield* sessions.create({ owner: "another" })
      yield* sessions.turn(other, (earlier) => earlier.append(userMessage("an earlier turn")))
      const promptFor = (session: OpenSession) => Effect.map(memory.context(session), (history) => Prompt.make([{ role: "system", content: "Be brief." }, ...history]))
      yield* Stream.runForEach(chat.messages, (message) => Effect.scoped(Effect.gen(function* () {
        const first = yield* sessions.open(chat.session)
        const second = yield* sessions.open(other)
        yield* first.append(userMessage(message))
        yield* second.append(userMessage("a task of its own"))
        // Memory is asked about the chat's session last, and both streams are made before either runs: a page that
        // placed a prompt by the last memory call, or when the stream was made, would give both to the chat.
        const secondPrompt = yield* promptFor(second)
        const firstPrompt = yield* promptFor(first)
        const calls = [modelAnswer(model.streamText({ prompt: secondPrompt }), second), modelAnswer(model.streamText({ prompt: firstPrompt }), first)]
        yield* Effect.all(calls, { concurrency: 2 })
        yield* chat.reply("both answered")
      })))
    })
    const main = program.pipe(
      Effect.provide(parts.watchMemory(flatMemory)),
      Effect.provide(parts.chatOn(parts.pane)),
      Effect.provide(parts.sessions()),
      Effect.provide(parts.inProcessJournal()),
      Effect.provide(parts.kernel()),
      Effect.provide(parts.model),
    )
    return Result.succeed(main)
  },
}

describe("two sessions calling the model at once, through modelAnswer", () => {
  test("each prompt, and each usage, names its own session and that session's turn", async () => {
    const runtime = await LessonRuntime.create(atOnce)
    opened.push(runtime)
    runtime.setModel(loadEcho())
    const heard: Array<Trace> = []
    runtime.onTrace((trace) => heard.push(trace))
    expect(await runtime.start({})).toEqual({ _tag: "Built" })
    const replied = new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply") { stop(); resolve() } }) })
    runtime.send("Hi.")
    await replied

    const chat = runtime.conversation
    const calls = heard.flatMap((trace) => (trace._tag === "Prompt" || trace._tag === "Usage" ? [trace] : []))
    // The calls ran at once: both prompts were sent before either call finished.
    expect(calls.map((trace) => trace._tag)).toEqual(["Prompt", "Prompt", "Usage", "Usage"])
    const placed = (tag: "Prompt" | "Usage") => calls.flatMap((trace) => (trace._tag === tag ? [`${trace.session === chat ? "chat" : "other"}, turn ${trace.turn}`] : []))
    expect(placed("Prompt")).toEqual(["other, turn 2", "chat, turn 1"])
    expect(new Set(placed("Usage"))).toEqual(new Set(["other, turn 2", "chat, turn 1"]))
    // Each prompt holds its own session's conversation, so the session it names is the one it was built from.
    const said = heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace.messages.map((message) => message.text)] : []))
    expect(said).toEqual([["Be brief.", "an earlier turn", "a task of its own"], ["Be brief.", "Hi."]])
    // Memory was asked about the chat's session last: the guess a call with no turn falls back to would have named it twice.
    expect(heard.flatMap((trace) => (trace._tag === "Context" ? [trace.session === chat ? "chat" : "other"] : []))).toEqual(["other", "chat"])
  })
})

describe("a turn in a second session, inside the chat's turn", () => {
  test("every trace names its session, the chat stays busy through the helper's end, and the board shows the chat's turn", async () => {
    const runtime = await LessonRuntime.create(twoSessions)
    opened.push(runtime)
    runtime.setModel(loadEcho())
    const heard: Array<Trace> = []
    // When the helper's turn ends, the chat's is still open.
    const busyAtHelperEnd: Array<boolean> = []
    runtime.onTrace((trace) => {
      heard.push(trace)
      if (trace._tag === "Event" && trace.event.name === turnEndedEvent.name && trace.event.session !== runtime.conversation) busyAtHelperEnd.push(runtime.busy)
    })
    expect(await runtime.start({})).toEqual({ _tag: "Built" })
    const replied = new Promise<void>((resolve) => { const stop = runtime.onTrace((trace) => { if (trace._tag === "Reply") { stop(); resolve() } }) })
    runtime.send("Hi.")
    await replied

    const chat = runtime.conversation
    const sessionsOf = (tag: "Context" | "Prompt") => heard.flatMap((trace) => (trace._tag === tag ? [trace.session === chat ? "chat" : "helper"] : []))
    expect(sessionsOf("Context")).toEqual(["chat", "helper", "chat"])
    expect(sessionsOf("Prompt")).toEqual(["chat", "helper", "chat"])
    // Each prompt is stamped with its own session's turn: the helper's first, the chat's first.
    expect(heard.flatMap((trace) => (trace._tag === "Prompt" ? [trace.turn] : []))).toEqual([1, 1, 1])
    expect(busyAtHelperEnd).toEqual([true])

    // The chat's board: one turn, two model calls, and nothing of the helper's.
    const board = heard.reduce((built, trace, index) => record(built, trace, index), emptyBoard(chat))
    const view = viewOf(board, 1)
    expect(view.calls.length).toBe(2)
    expect(JSON.stringify(view.calls)).not.toContain("a task of its own")
  })
})
