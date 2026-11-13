// The page's runtime when a program runs a turn in a second session inside the
// chat's turn, as a sub-agent does: every trace names its session, the chat
// stays busy until its own turn ends, and the Context board shows the chat's
// turn only.
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Result, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { assistantMessage, Sessions, turnEndedEvent, userMessage } from "@xandreed/core/kernel"
import type { OpenSession } from "@xandreed/core/kernel"
import { flatMemory, Memory } from "@xandreed/sdk/kernel"
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
