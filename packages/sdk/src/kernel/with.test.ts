import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Ref, Stream } from "effect"
import { Core, definePlugin, estimateRequest, Memory, messageOf, requestSentEvent, Settings, Tokens, turnMessageOf } from "@xandreed/core/kernel"
import { Agent, inMemoryStorage, windowDroppedEvent, windowMemory, windowPressureEvent } from "./index.js"
import { answer, answering, recording, scripted } from "./testing.js"

const system = "You are a friendly tutor."
const FIVE = ["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.loop.assistant.message", "plugin.session.turn.ended"]

/** A memory that sends only the message the turn answers, and counts the requests it hears of. */
const forgetful = (heard: Ref.Ref<number>) => definePlugin({
  name: "forgetful",
  provides: Memory,
  make: Effect.gen(function* () {
    const core = yield* Core
    const settings = yield* Settings
    yield* core.on(requestSentEvent, () => Ref.update(heard, (count) => count + 1), { wait: true })
    return Memory.of({
      open: (session) => Effect.succeed({
        build: () => Effect.map(session.journal, (journal) => {
          const asked = Option.toArray(turnMessageOf(journal))
          const messages = journal.filter((event) => asked.includes(event.seq)).flatMap((event) => Option.toArray(messageOf(event)))
          return { messages: asked, estimatedTokens: estimateRequest(settings.system, messages), budgetTokens: Tokens.make(3000) }
        }),
      }),
    })
  }),
})

/** Wait, without sleeping, until `seen` holds `count` events: a background listener publishes on its own fiber. */
const waitFor = <A>(seen: Effect.Effect<ReadonlyArray<A>>, count: number, tries = 5000): Effect.Effect<void> =>
  Effect.flatMap(seen, (all) => all.length >= count || tries === 0 ? Effect.void : Effect.andThen(Effect.yieldNow, Effect.suspend(() => waitFor(seen, count, tries - 1))))

describe("agent.with", () => {
  test("replaces memory: the model is sent what the new memory builds, the old memory's listener is gone, and the session goes on", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Fine.")
      const heard = yield* Ref.make(0)
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: forgetful(heard) })
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "One")
      yield* agent.send(session, "Two")
      const heardBefore = yield* Ref.get(heard)
      const next = yield* agent.with({ memory: windowMemory({ budgetTokens: 3000 }) })
      const reply = yield* next.send(session, "Three")
      const refused = yield* Effect.flip(agent.send(session, "Four"))
      const refusedAgain = yield* Effect.flip(agent.with({ system: "Other." }))
      return { heardBefore, heardAfter: yield* Ref.get(heard), reply, refused, refusedAgain, received: yield* received, inspection: yield* next.inspect(session) }
    })))
    // Under the old memory each request held the turn's message alone.
    expect(result.received.slice(0, 2)).toEqual([
      [{ role: "system", text: system }, { role: "user", text: "One" }],
      [{ role: "system", text: system }, { role: "user", text: "Two" }],
    ])
    // Under the new one, the same session's earlier messages are all there: the window memory built it from the journal the old agent wrote.
    expect(result.received[2]).toEqual([
      { role: "system", text: system },
      { role: "user", text: "One" },
      { role: "assistant", text: "Fine." },
      { role: "user", text: "Two" },
      { role: "assistant", text: "Fine." },
      { role: "user", text: "Three" },
    ])
    expect(result.reply).toEqual({ text: "Fine." })
    // The old memory's listener heard its own two requests and not the third.
    expect([result.heardBefore, result.heardAfter]).toEqual([2, 2])
    expect(result.inspection.events.map((event): string => event.name)).toEqual([...FIVE, ...FIVE, ...FIVE])
    expect(result.inspection.state).toEqual({ _tag: "Free", turns: 3 })
    // The replaced handle takes no more turns and cannot be replaced twice.
    expect(result.refused).toMatchObject({ _tag: "AgentRefused", reason: "Replaced" })
    expect(result.refusedAgain).toMatchObject({ _tag: "AgentRefused", reason: "Replaced" })
  })

  test("rebuilds what it keeps: a new system text reaches memory's estimate, the stored request and the model, and each listener is there once", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Fine.")
      const record = yield* recording([windowPressureEvent, windowDroppedEvent])
      // The same memory object before and after: `pressureAt: 0` makes its listener announce every request.
      const memory = windowMemory({ budgetTokens: 3000, pressureAt: 0 })
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory, plugins: [record.plugin] })
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "One")
      // The pressure listener works in the background: wait for what it publishes before its agent is replaced.
      yield* waitFor(record.seen, 1)
      const next = yield* agent.with({ system: "You are a terse tutor who answers in one word." })
      yield* next.send(session, "Two")
      yield* waitFor(record.seen, 2)
      // Then give a stray third announcement, from a listener that should be gone, the chance to show.
      yield* waitFor(record.seen, 3, 200)
      return { seen: yield* record.seen, received: yield* received, inspection: yield* next.inspect(session) }
    })))
    expect(result.received.map((call) => call[0])).toEqual([
      { role: "system", text: system },
      { role: "system", text: "You are a terse tutor who answers in one word." },
    ])
    expect(result.inspection.requests.map((request) => [request.system, Number(request.estimatedTokens)])).toEqual([
      [system, 8],
      ["You are a terse tutor who answers in one word.", 12 + 1 + 2 + 1],
    ])
    // One announcement per request: the first agent's listener went with it, and the second agent has one of its own.
    expect(result.seen.map((event) => `${event.name} in turn ${event.turn}`)).toEqual(["plugin.window.pressure in turn 1", "plugin.window.pressure in turn 2"])
  })

  test("a turn the replaced agent is running finishes; `with` returns after it", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const asked = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const { model } = yield* scripted((call) => call === 0 ? Stream.unwrap(Effect.as(Effect.andThen(Deferred.succeed(asked, undefined), Deferred.await(go)), answer("First."))) : answer("Second."))
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      const running = yield* Effect.forkChild(agent.send(session, "One"))
      yield* Deferred.await(asked)
      const replaced = yield* Effect.forkChild(agent.with({ system: "Other." }))
      yield* waitFor(Effect.succeed([]), 1, 200)
      // Replaced at once for new turns, while `with` waits for the running one.
      const refused = yield* Effect.flip(agent.send(session, "Too late"))
      const waiting = replaced.pollUnsafe() === undefined
      yield* Deferred.succeed(go, undefined)
      const first = yield* Fiber.join(running)
      const next = yield* Fiber.join(replaced)
      const second = yield* next.send(session, "Two")
      return { refused, waiting, first, second, names: (yield* next.inspect(session)).events.map((event): string => event.name) }
    })))
    expect(result.refused).toMatchObject({ _tag: "AgentRefused", reason: "Replaced" })
    expect(result.waiting).toBe(true)
    expect(result.first).toEqual({ text: "First." })
    expect(result.second).toEqual({ text: "Second." })
    expect(result.names).toEqual([...FIVE, ...FIVE])
  })

  test("storage and sessions are not its to change", () => {
    const changes = (agent: Effect.Success<ReturnType<typeof Agent.define>>) => [
      agent.with({ system: "Other." }),
      // @ts-expect-error storage stays the agent's own: `with` takes model, system, memory, loop and plugins
      agent.with({ storage: inMemoryStorage() }),
    ]
    expect(changes).toBeFunction()
  })
})
