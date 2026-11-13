import { describe, expect, test } from "bun:test"
import { Effect, Ref, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/ai"
import { assistantMessage, Core, kernel, Sessions, turnStartedEvent, userMessage } from "@xandreed/core/kernel"
import type { SessionId } from "@xandreed/core/kernel"
import { flatMemory, inProcessJournal, Memory, scriptedModel, sessions } from "./index.js"

/*
 * The first lesson's program, as a test: the program is the loop. It takes
 * messages one at a time, runs a turn for each over the modules it is
 * given, and each turn sees the turns before it. `docs/kernel.md` quotes
 * the turn, the program and how it is run.
 */

describe("the lesson's program", () => {
  test("three messages are answered in order, each turn seeing the turns before it, and the journal holds the conversation only", async () => {
    const result = await Effect.runPromise(Effect.gen(function* () {
      const { model, calls } = yield* scriptedModel([
        { _tag: "Answers", pieces: ["Hello, ", "Ana!"] },
        { _tag: "Answers", pieces: ["Your name is Ana."] },
        { _tag: "Answers", pieces: ["A-n-A."] },
      ])
      const lines = yield* Ref.make<ReadonlyArray<string>>([])
      /** What a host shows: here, a line kept for the test. */
      const show = (line: string) => Ref.update(lines, (all) => [...all, line])
      const messages = Stream.fromIterable(["Hi, I'm Ana.", "What's my name?", "Spell it backwards."])

      // #region turn
      // The system text: code, sent first in every prompt, never stored.
      const system = "You are a friendly tutor. Keep answers short."

      // One turn: what the agent does with one message.
      const turn = (conversation: SessionId, message: string) =>
        Effect.scoped(
          Effect.gen(function* () {
            const sessions = yield* Sessions
            const memory = yield* Memory
            const model = yield* LanguageModel.LanguageModel

            // Open a turn. It closes when this scope ends: answered, failed or stopped.
            const session = yield* sessions.open(conversation)

            // Store the message. The journal holds the conversation, and only that.
            yield* session.append(userMessage(message))

            // Ask memory for the context: what of the conversation the model sees.
            const history = yield* memory.context(session)

            // The prompt: the system text first, then the context. Built fresh every time, never stored.
            const prompt = Prompt.make([{ role: "system", content: system }, ...history])

            // Call the model. Show each piece as it streams in, and join them into the answer.
            const answer = yield* model.streamText({ prompt }).pipe(
              Stream.tap((part) => (part.type === "error" ? Effect.fail(part.error) : Effect.void)),
              Stream.filter((part) => part.type === "text-delta"),
              Stream.map((part) => part.delta),
              Stream.tap((piece) => show(piece)),
              Stream.mkString,
            )

            // Store the answer, so the next turn's context has it. Return it.
            yield* session.append(assistantMessage(answer))
            return answer
          }),
        )
      // #endregion turn

      // #region program
      // The program: one conversation, one turn per message, in order.
      const program = Effect.scoped(
        Effect.gen(function* () {
          const core = yield* Core
          const sessions = yield* Sessions
          const conversation = yield* sessions.create({ owner: "learner" })

          // On boot: hook an event, as an editor's autocommand would.
          yield* core.on(turnStartedEvent, (started) => show(`(turn ${started.data.turn})`), { name: "lesson", wait: true })

          // Then, for each message: one turn, in order. One that arrives mid-turn waits for its own.
          const replies = yield* Stream.runCollect(Stream.mapEffect(messages, (message) => turn(conversation, message)))
          return { replies, journal: yield* sessions.read(conversation) }
        }),
      )

      // Run it: give the program the modules it asks for. Each can use the ones given after it.
      const main = program.pipe(
        Effect.provide(flatMemory),           // what of the journal the model sees
        Effect.provide(sessions()),           // conversations and their turns
        Effect.provide(inProcessJournal()),   // where every record is kept
        Effect.provide(kernel()),             // events every module can hook
        Effect.provide(model),                // any LanguageModel layer; scriptedModel(...) in tests
      )
      // #endregion program

      const { replies, journal } = yield* main
      return { replies, journal, calls: yield* calls, lines: yield* Ref.get(lines) }
    }))

    // The replies come back in order, and each turn's start was heard before its answer.
    expect(result.replies).toEqual(["Hello, Ana!", "Your name is Ana.", "A-n-A."])
    expect(result.lines).toEqual(["(turn 1)", "Hello, ", "Ana!", "(turn 2)", "Your name is Ana.", "(turn 3)", "A-n-A."])
    // The journal holds three turns, each its start, its message, its answer and its end: the conversation, and nothing about a request.
    expect(result.journal.events.map((event) => `${event.turn} ${event.name}`)).toEqual([1, 2, 3].flatMap((turn) => [
      `${turn} core.session.turn.started`,
      `${turn} conversation.user.message`,
      `${turn} conversation.assistant.message`,
      `${turn} core.session.turn.ended`,
    ]))
    expect(JSON.stringify(result.journal.events)).not.toContain("You are a friendly tutor.")
    // The second prompt the model received is the system text, the first turn, then its own message.
    expect(result.calls[1]).toEqual([
      { role: "system", text: "You are a friendly tutor. Keep answers short." },
      { role: "user", text: "Hi, I'm Ana." },
      { role: "assistant", text: "Hello, Ana!" },
      { role: "user", text: "What's my name?" },
    ])
  })
})
