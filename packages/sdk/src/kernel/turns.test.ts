import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { assistantDeltaEvent, definePlugin, Memory, Seq, Tokens } from "@xandreed/core/kernel"
import type { Response } from "effect/ai"
import type { AgentHandle } from "./index.js"
import { Agent, inProcessJournal, isOverBudget, windowMemory } from "./index.js"
import { answer, answering, counting, modelDown, recording, scripted } from "./testing.js"

const system = "You are a friendly tutor."
const FIVE = ["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.loop.assistant.message", "plugin.session.turn.ended"]

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

/** The names a session's journal holds, and how each turn ended. */
const journalOf = (agent: AgentHandle, session: Parameters<AgentHandle["inspect"]>[0]) => Effect.map(agent.inspect(session), (inspection) => ({
  names: inspection.events.map((event): string => event.name),
  ends: inspection.events.filter((event) => event.name === "plugin.session.turn.ended").map((event) => event.data),
  state: inspection.state,
  events: inspection.events,
  requests: inspection.requests,
}))

describe("twenty turns", () => {
  test("five stored events a turn, every message text stored once, and each request pointing at all that came before", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* counting
      const deltas = yield* recording([assistantDeltaEvent])
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [deltas.plugin] })
      const session = yield* agent.createSession({ owner: "learner" })
      const replies = yield* Effect.forEach(Array.from({ length: 20 }, (_, turn) => `Question ${turn + 1}?`), (question) => agent.send(session, question), { concurrency: 1 })
      return { replies, journal: yield* journalOf(agent, session), received: yield* received, deltas: yield* deltas.seen }
    })))
    expect(result.replies.map((reply) => reply.text)).toEqual(Array.from({ length: 20 }, (_, turn) => `Reply ${turn + 1}.`))
    expect(result.journal.names).toEqual(Array.from({ length: 20 }, () => FIVE).flat())
    expect(result.journal.state).toEqual({ _tag: "Free", turns: 20 })
    // Every message's text is in the journal once: on the envelope of its own record, in no request and no turn's end.
    const text = JSON.stringify(result.journal.events)
    const texts = Array.from({ length: 20 }, (_, turn) => [`Question ${turn + 1}?`, `Reply ${turn + 1}.`]).flat()
    expect(texts.map((message) => text.split(JSON.stringify(message)).length - 1)).toEqual(texts.map(() => 1))
    // The deltas were published and stored nowhere.
    expect(result.deltas).toHaveLength(20)
    expect(result.journal.names).not.toContain("plugin.loop.assistant.delta")
    // The last request points at the 39 messages before the answer, and resolved it is what the model received.
    const last = result.journal.requests.at(-1)
    expect(last?.messages).toHaveLength(39)
    expect([{ role: "system", text: last?.system }, ...(last?.messages ?? []).map(({ message }) => ({ role: message._tag.toLowerCase(), text: message.text }))]).toEqual([...(result.received.at(-1) ?? [])])
  })
})

describe("every exit closes the turn with its outcome, and the next send works", () => {
  test("a model that fails", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* scripted((call) => call === 0 ? Stream.fail(modelDown) : answer("Back."))
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      const failed = yield* Effect.flip(agent.send(session, "Hello"))
      const afterFailure = yield* journalOf(agent, session)
      const reply = yield* agent.send(session, "Again")
      return { failed, afterFailure, reply, journal: yield* journalOf(agent, session) }
    })))
    expect(result.failed._tag).toBe("AiError")
    expect(result.afterFailure.names).toEqual(["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.session.turn.ended"])
    expect(result.afterFailure.ends).toEqual([{ turn: 1, outcome: { _tag: "Failed", reason: expect.stringContaining("AiError") } }])
    expect(result.afterFailure.state).toEqual({ _tag: "Free", turns: 1 })
    expect(result.reply).toEqual({ text: "Back." })
    expect(result.journal.names.slice(4)).toEqual(FIVE)
    expect(result.journal.ends.at(-1)).toEqual({ turn: 2, outcome: { _tag: "Completed" } })
  })

  test("an interrupt of a model that never answers", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const { model } = yield* scripted((call) => call === 0 ? Stream.unwrap(Effect.as(Deferred.succeed(asked, undefined), Stream.never)) : answer("Back."))
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      const turn = yield* Effect.forkChild(agent.send(session, "Hello"))
      yield* Deferred.await(asked)
      yield* Fiber.interrupt(turn)
      const afterInterrupt = yield* journalOf(agent, session)
      const reply = yield* agent.send(session, "Again")
      return { afterInterrupt, reply, journal: yield* journalOf(agent, session) }
    })))
    expect(result.afterInterrupt.names).toEqual(["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.session.turn.ended"])
    expect(result.afterInterrupt.ends).toEqual([{ turn: 1, outcome: { _tag: "Interrupted" } }])
    expect(result.afterInterrupt.state).toEqual({ _tag: "Free", turns: 1 })
    expect(result.reply).toEqual({ text: "Back." })
    expect(result.journal.names.slice(4)).toEqual(FIVE)
  })

  test("a turn that alone is over the budget: memory's own error, with the estimate and the budget", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Hi.")
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 8 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      const refused = yield* Effect.flip(agent.send(session, "Hello"))
      const afterRefusal = yield* journalOf(agent, session)
      const calls = (yield* received).length
      const reply = yield* agent.send(session, "Hi")
      return { refused, afterRefusal, calls, reply, journal: yield* journalOf(agent, session), received: yield* received }
    })))
    // 7 tokens of system text and 2 of message, under a budget of 8. The error is the plugin's own, told by its guard.
    expect(isOverBudget(result.refused) ? { estimatedTokens: Number(result.refused.estimatedTokens), budgetTokens: Number(result.refused.budgetTokens) } : result.refused._tag).toEqual({ estimatedTokens: 9, budgetTokens: 8 })
    expect(result.calls).toBe(0)
    expect(result.afterRefusal.names).toEqual(["plugin.session.turn.started", "plugin.loop.user.message", "plugin.session.turn.ended"])
    expect(result.afterRefusal.ends).toEqual([{ turn: 1, outcome: { _tag: "Failed", reason: expect.stringContaining("OverBudget") } }])
    // The next turn fits once the refused turn's message leaves the window, which the window records.
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.journal.names.slice(3)).toEqual([
      "plugin.session.turn.started",
      "plugin.loop.user.message",
      "plugin.window.dropped",
      "plugin.loop.request.sent",
      "plugin.loop.assistant.message",
      "plugin.session.turn.ended",
    ])
    expect(result.journal.events[5]).toMatchObject({ skippable: true, data: { through: 2 } })
    expect(result.received).toEqual([[{ role: "system", text: system }, { role: "user", text: "Hi" }]])
  })

  test("a second send during a turn is refused, and stores nothing", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const { model } = yield* scripted(() => Stream.unwrap(Effect.as(Effect.andThen(Deferred.succeed(asked, undefined), Deferred.await(go)), answer("Hi."))))
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      const first = yield* Effect.forkChild(agent.send(session, "Hello"))
      yield* Deferred.await(asked)
      const refused = yield* Effect.flip(agent.send(session, "Me too"))
      yield* Deferred.succeed(go, undefined)
      const reply = yield* Fiber.join(first)
      return { refused, reply, journal: yield* journalOf(agent, session) }
    })))
    expect(result.refused).toMatchObject({ _tag: "SessionRefused", reason: "SessionBusy" })
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.journal.names).toEqual(FIVE)
  })
})

describe("a model that fails part-way through its answer", () => {
  test("fails the turn with a typed error: no partial reply, no assistant message, and the next send works", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      // The first call streams half an answer and then an error part; the second answers.
      const broken = Stream.fromIterable<Response.StreamPartEncoded>([
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "Half an ans" },
        { type: "error", error: { status: 529, body: "overloaded" } },
      ])
      const { model } = yield* scripted((call) => call === 0 ? broken : answer("Whole."))
      const deltas = yield* recording([assistantDeltaEvent])
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [deltas.plugin] })
      const session = yield* agent.createSession({ owner: "learner" })
      const failed = yield* Effect.result(agent.send(session, "Hello"))
      const afterFailure = yield* journalOf(agent, session)
      const reply = yield* agent.send(session, "Again")
      return { failed, afterFailure, reply, deltas: (yield* deltas.seen).map((event) => event.data), journal: yield* journalOf(agent, session) }
    })))
    expect(result.failed).toMatchObject({ _tag: "Failure", failure: { _tag: "ModelFailed", cause: { status: 529, body: "overloaded" } } })
    // What streamed before the error was shown live; none of it is stored as an answer.
    expect(result.deltas[0]).toEqual({ text: "Half an ans" })
    expect(result.afterFailure.names).toEqual(["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.session.turn.ended"])
    expect(result.afterFailure.ends).toEqual([{ turn: 1, outcome: { _tag: "Failed", reason: expect.stringContaining("ModelFailed") } }])
    expect(JSON.stringify(result.afterFailure.events)).not.toContain("Half an ans")
    expect(result.reply).toEqual({ text: "Whole." })
    expect(result.journal.names.slice(4)).toEqual(FIVE)
  })
})

describe("a request memory builds badly", () => {
  /** A memory whose request points at the turn's start, a record that bears no message. */
  const misdirected = definePlugin({
    name: "misdirected",
    requires: [],
    provides: Memory,
    make: Effect.succeed(Memory.of({
      build: () => Effect.succeed({ messages: [Seq.make(1)], estimatedTokens: Tokens.make(1), budgetTokens: Tokens.make(3000) }),
    })),
  })

  test("is refused before anything of it is stored, so the session stays readable", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Hi.")
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: misdirected })
      const session = yield* agent.createSession({ owner: "learner" })
      const refused = yield* Effect.flip(agent.send(session, "Hello"))
      // Inspecting resolves every stored request: a bad pointer stored for good would fail it from here on.
      const journal = yield* journalOf(agent, session)
      const next = yield* agent.with({ memory: windowMemory({ budgetTokens: 3000 }) })
      return { refused, journal, calls: (yield* received).length, reply: yield* next.send(session, "Again") }
    })))
    expect(result.refused).toMatchObject({ _tag: "RequestRefused", reason: "UnknownMessage", seq: 1 })
    expect(result.calls).toBe(0)
    expect(result.journal.names).toEqual(["plugin.session.turn.started", "plugin.loop.user.message", "plugin.session.turn.ended"])
    expect(result.journal.requests).toEqual([])
    expect(result.reply).toEqual({ text: "Hi." })
  })
})

describe("what an agent refuses before it starts", () => {
  test("a message of no text, with a reason of its own, and nothing is stored for it", async () => {
    const result = await run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      return {
        empty: yield* Effect.flip(agent.send(session, "")),
        blank: yield* Effect.flip(agent.send(session, " \n\t ")),
        names: (yield* journalOf(agent, session)).names,
        reply: yield* agent.send(session, " Hello "),
      }
    })))
    expect(result.empty).toMatchObject({ _tag: "AgentRefused", reason: "EmptyMessage" })
    expect(result.blank).toMatchObject({ _tag: "AgentRefused", reason: "EmptyMessage" })
    expect(result.names).toEqual([])
    expect(result.reply).toEqual({ text: "Hi." })
  })

  test("a window memory with a budget that is none fails the agent's definition with a typed error, not a crash", async () => {
    const defined = (budgetTokens: number) => run(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      return yield* Effect.result(Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens }) }))
    })).pipe(Effect.map((result) => result._tag === "Failure" ? result.failure._tag : "defined")))
    expect(await Promise.all([Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 0.5].map(defined))).toEqual(["InvalidBudget", "InvalidBudget", "InvalidBudget", "InvalidBudget", "InvalidBudget"])
    expect(await Promise.all([1, 8.9, 3000].map(defined))).toEqual(["defined", "defined", "defined"])
  })
})
