import { describe, expect, test } from "bun:test"
import { Effect, Layer, Ref } from "effect"
import type { LanguageModel } from "effect/ai"
import { Core, kernel, Sessions, turnEndedEvent } from "@xandreed/core/kernel"
import { assistantDeltaEvent } from "./contracts/loop/conversation.entity.js"
import { settings } from "./contracts/loop/settings.adapter.js"
import type { JournalStorage } from "@xandreed/core/kernel"
import type { Loop } from "./contracts/loop/loop.port.js"
import type { Settings } from "./contracts/loop/settings.port.js"
import type { Memory } from "./contracts/memory/memory.port.js"
import { Inbox, inbox, inboxQueuedEvent, inProcessJournal, scriptedModel, sessions, stepLoop, windowMemory } from "./index.js"
import type { InvalidBudget } from "./index.js"

/*
 * The first lesson's chat, as a test: three messages queued at once, each
 * answered in a turn of its own, in order, every turn seeing the ones
 * before it. `docs/kernel.md` quotes the stack and the program.
 */

describe("the lesson's queue", () => {
  test("three messages queued at once are answered in order, each turn seeing the turns before it", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, calls } = yield* scriptedModel([
        { _tag: "Answers", pieces: ["Hello, ", "Ana!"] },
        { _tag: "Answers", pieces: ["Your name is Ana."] },
        { _tag: "Answers", pieces: ["A-n-A."] },
      ])
      const lines = yield* Ref.make<ReadonlyArray<string>>([])
      /** What a host shows: here, a line kept for the test. */
      const show = (line: string) => Ref.update(lines, (all) => [...all, line])

      // #region agent
      const AgentLive: Layer.Layer<Inbox | Loop | Memory | Sessions | JournalStorage | Core | Settings | LanguageModel.LanguageModel, InvalidBudget> = inbox.pipe(
        Layer.provideMerge(stepLoop),
        Layer.provideMerge(windowMemory({ budgetTokens: 3000 })),
        Layer.provideMerge(settings({ system: "You are a friendly tutor." })),   // the system text the loop and memory read
        Layer.provideMerge(sessions()),
        Layer.provideMerge(inProcessJournal()),
        Layer.provideMerge(kernel()),                                            // Core: events, and nothing of a workflow
        Layer.provideMerge(model),                                               // any LanguageModel layer; scriptedModel(...) in tests
      )
      // #endregion agent

      // #region program
      const program = Effect.gen(function* () {
        const core     = yield* Core
        const sessions = yield* Sessions
        const inbox    = yield* Inbox

        const session = yield* sessions.create({ owner: "learner" })

        // Follow the session: answers as they stream, each turn as it ends, and each message as it is queued.
        // A listener is registered before this line returns, so nothing is missed.
        yield* core.on(assistantDeltaEvent, (delta) => show(delta.data.text), { name: "lesson" })
        yield* core.on(turnEndedEvent, (ended) => show(`(turn ${ended.turn} done)`), { name: "lesson" })
        yield* core.on(inboxQueuedEvent, (queued) => show(`(queued ${queued.data.ticket})`), { name: "lesson", wait: true })

        // Queue three messages without waiting. Each is answered in a turn of its own, in order,
        // and each turn sees the turns before it.
        const queued = yield* Effect.forEach(
          ["Hi, I'm Ana.", "What's my name?", "Spell it backwards."],
          (message) => inbox.enqueue(session, message),
          { concurrency: 1 },
        )
        const replies = yield* Effect.forEach(queued, (entry) => entry.reply, { concurrency: "unbounded" })
        return { session, replies, journal: yield* sessions.read(session) }
      }).pipe(Effect.provide(AgentLive))
      // #endregion program

      const { session, replies, journal } = yield* program
      return { session, replies, journal, calls: yield* calls, lines: yield* Ref.get(lines) }
    })))

    // The replies come back in order.
    expect(result.replies).toEqual([{ text: "Hello, Ana!" }, { text: "Your name is Ana." }, { text: "A-n-A." }])
    // The journal holds three turns, in order, each with its message.
    const turns = result.journal.events.filter((event) => event.name === "core.session.turn.started").map((event) => event.data)
    expect(turns).toEqual([{ turn: 1 }, { turn: 2 }, { turn: 3 }])
    expect(result.journal.events.flatMap((event) => event.name === "plugin.loop.user.message" && event.message !== undefined ? [event.message.text] : []))
      .toEqual(["Hi, I'm Ana.", "What's my name?", "Spell it backwards."])
    expect(result.journal.events.filter((event) => event.name === "core.session.turn.ended").map((event) => event.data))
      .toEqual([1, 2, 3].map((turn) => ({ turn, outcome: { _tag: "Completed" } })))
    // The second request the model received holds the first turn's messages, then its own.
    expect(result.calls[1]).toEqual([
      { role: "system", text: "You are a friendly tutor." },
      { role: "user", text: "Hi, I'm Ana." },
      { role: "assistant", text: "Hello, Ana!" },
      { role: "user", text: "What's my name?" },
    ])
    // `plugin.inbox.queued` was published three times, with tickets 1, 2 and 3, in that order: the listener the publisher waits for heard each before its turn started.
    expect(result.lines.filter((line) => line.startsWith("(queued"))).toEqual(["(queued 1)", "(queued 2)", "(queued 3)"])
  })
})
