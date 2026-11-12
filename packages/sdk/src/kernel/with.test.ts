import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Predicate, Ref, Stream } from "effect"
import { assistantMessageEvent, Core, definePlugin, estimateRequest, Memory, messageOf, requestSentEvent, Settings, Tokens, turnMessageOf, userMessageEvent } from "@xandreed/core/kernel"
import type { AgentHandle } from "./index.js"
import { Agent, inMemoryStorage, windowMemory } from "./index.js"
import { answer, answering, scripted } from "./testing.js"

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

/** An extra plugin that counts, while the publisher waits, the assistant messages it hears: what it has counted when `send` returns is exact. */
const counting = (heard: Ref.Ref<number>, name = "counter") => definePlugin({
  name,
  make: Effect.flatMap(Core, (core) => core.on(assistantMessageEvent, () => Ref.update(heard, (count) => count + 1), { wait: true })),
})

/** A model whose first call waits until it is told to go. */
const gated = Effect.gen(function* () {
  const asked = yield* Deferred.make<void>()
  const go = yield* Deferred.make<void>()
  const { model } = yield* scripted((call) => call === 0 ? Stream.unwrap(Effect.as(Effect.andThen(Deferred.succeed(asked, undefined), Deferred.await(go)), answer("First."))) : answer("Later."))
  return { model, asked: Deferred.await(asked), go: Deferred.succeed(go, undefined) }
})

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
    // The old memory's listener waited for its own two requests and was not there for the third.
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
      const heard = yield* Ref.make(0)
      // The same memory object and the same extra plugin before and after: both are built again, the first build closed.
      const memory = windowMemory({ budgetTokens: 3000 })
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory, plugins: [counting(heard)] })
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "One")
      const next = yield* agent.with({ system: "You are a terse tutor who answers in one word." })
      yield* next.send(session, "Two")
      return { heard: yield* Ref.get(heard), received: yield* received, inspection: yield* next.inspect(session) }
    })))
    expect(result.received.map((call) => call[0])).toEqual([
      { role: "system", text: system },
      { role: "system", text: "You are a terse tutor who answers in one word." },
    ])
    expect(result.inspection.requests.map((request) => [request.system, Number(request.estimatedTokens)])).toEqual([
      [system, 8],
      ["You are a terse tutor who answers in one word.", 12 + 1 + 2 + 1],
    ])
    // One listener per answer: had the first agent's listener stayed, the second answer would count twice.
    expect(result.heard).toBe(2)
  })

  test("switches at once while a turn is running: that turn finishes on its own parts, which close after it", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const model = yield* gated
      const oldHeard = yield* Ref.make(0)
      const newHeard = yield* Ref.make(0)
      const agent = yield* Agent.define({ model: model.model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [counting(oldHeard, "old-counter")] })
      const session = yield* agent.createSession({ owner: "learner" })
      const other = yield* agent.createSession({ owner: "learner" })
      const running = yield* Effect.forkChild(agent.send(session, "One"))
      yield* model.asked
      // `with` does not wait for the running turn: it returns the successor while the model is still thinking.
      const next = yield* agent.with({ plugins: [counting(newHeard, "new-counter")] })
      const refused = yield* Effect.flip(agent.send(other, "Too late"))
      yield* model.go
      const first = yield* Fiber.join(running)
      const afterOldTurn = [yield* Ref.get(oldHeard), yield* Ref.get(newHeard)]
      const second = yield* next.send(session, "Two")
      return { refused, first, second, afterOldTurn, atEnd: [yield* Ref.get(oldHeard), yield* Ref.get(newHeard)], names: (yield* next.inspect(session)).events.map((event): string => event.name) }
    })))
    expect(result.refused).toMatchObject({ _tag: "AgentRefused", reason: "Replaced" })
    expect(result.first).toEqual({ text: "First." })
    expect(result.second).toEqual({ text: "Later." })
    // The running turn's answer was heard by its own agent's listener, still there, and by the successor's.
    expect(result.afterOldTurn).toEqual([1, 1])
    // After it, the replaced agent's parts are closed: only the successor's listener hears the next answer.
    expect(result.atEnd).toEqual([1, 2])
    expect(result.names).toEqual([...FIVE, ...FIVE])
  })

  test("interrupted before the switch, it changes nothing: the agent works on, and what was built for the successor is released", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Fine.")
      const building = yield* Deferred.make<void>()
      const released = yield* Ref.make(false)
      const strayHeard = yield* Ref.make(0)
      // A plugin of the successor that is built whole: it registers a listener and acquires something.
      const early = definePlugin({
        name: "early",
        make: Effect.gen(function* () {
          const core = yield* Core
          yield* core.on(userMessageEvent, () => Ref.update(strayHeard, (count) => count + 1), { wait: true })
          yield* Effect.addFinalizer(() => Ref.set(released, true))
        }),
      })
      // And one built after it, which never finishes building.
      const slow = definePlugin({ name: "slow", make: Effect.andThen(Deferred.succeed(building, undefined), Effect.never) })
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      // `with` builds in this test's scope, which stays open: only `with` itself can release what it built.
      const replacing = yield* Effect.forkChild(agent.with({ plugins: [early, slow] }))
      yield* Deferred.await(building)
      yield* Fiber.interrupt(replacing)
      const reply = yield* agent.send(session, "Still there?")
      return { reply, released: yield* Ref.get(released), strayHeard: yield* Ref.get(strayHeard) }
    })))
    expect(result.reply).toEqual({ text: "Fine." })
    expect(result.released).toBe(true)
    expect(result.strayHeard).toBe(0)
  })

  test("that cannot build its successor fails with the plugin's own error and changes nothing", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Fine.")
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      const failed = yield* Effect.flip(agent.with({ memory: windowMemory({ budgetTokens: Number.NaN }) }))
      return { failed, reply: yield* agent.send(session, "Still there?") }
    })))
    expect(result.failed._tag).toBe("InvalidBudget")
    expect(result.reply).toEqual({ text: "Fine." })
  })

  test("called twice at once on one handle: the first to switch is the agent, the other is refused and what it built is released", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Fine.")
      const built = yield* Deferred.make<void>()
      const finish = yield* Deferred.make<void>()
      const released = yield* Ref.make(false)
      const lateHeard = yield* Ref.make(0)
      const winnerHeard = yield* Ref.make(0)
      // The plugin of the `with` that loses: it registers a listener, acquires something, and finishes building only when told.
      const late = definePlugin({
        name: "late",
        make: Effect.gen(function* () {
          const core = yield* Core
          yield* core.on(assistantMessageEvent, () => Ref.update(lateHeard, (count) => count + 1), { wait: true })
          yield* Effect.addFinalizer(() => Ref.set(released, true))
          yield* Deferred.succeed(built, undefined)
          yield* Deferred.await(finish)
        }),
      })
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      // Both pass the check that the handle is live, and both build. Each builds in this test's scope, which stays open.
      const losing = yield* Effect.forkChild(Effect.result(agent.with({ plugins: [late] })))
      yield* Deferred.await(built)
      const winner = yield* agent.with({ plugins: [counting(winnerHeard, "winner")] })
      yield* Deferred.succeed(finish, undefined)
      const lost = yield* Fiber.join(losing)
      const releasedAtOnce = yield* Ref.get(released)
      const reply = yield* winner.send(session, "Hello")
      return { lost, releasedAtOnce, reply, heard: [yield* Ref.get(lateHeard), yield* Ref.get(winnerHeard)] }
    })))
    expect(result.lost).toMatchObject({ _tag: "Failure", failure: { _tag: "AgentRefused", reason: "Replaced" } })
    expect(result.releasedAtOnce).toBe(true)
    expect(result.reply).toEqual({ text: "Fine." })
    // The successor that lost is no agent: its listener is gone, and only the winner's heard the turn.
    expect(result.heard).toEqual([0, 1])
  })

  test("called from inside a turn of the agent it would replace, it is refused at once and the turn goes on", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Fine.")
      const self = yield* Ref.make(Option.none<AgentHandle>())
      const tried = yield* Ref.make<ReadonlyArray<string>>([])
      // A listener the turn waits for tries to replace the agent the turn is running on.
      const meddler = definePlugin({
        name: "meddler",
        make: Effect.flatMap(Core, (core) => core.on(userMessageEvent, () => Effect.flatMap(Ref.get(self), Option.match({
          onNone: () => Effect.void,
          onSome: (agent) => Effect.matchEffect(Effect.scoped(agent.with({ system: "Mine now." })), {
            onSuccess: () => Ref.update(tried, (all) => [...all, "replaced"]),
            onFailure: (error) => Ref.update(tried, (all) => [...all, Predicate.hasProperty(error, "reason") ? String(error.reason) : error._tag]),
          }),
        })), { wait: true })),
      })
      const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [meddler] })
      yield* Ref.set(self, Option.some(agent))
      const session = yield* agent.createSession({ owner: "learner" })
      const reply = yield* agent.send(session, "Hello")
      const again = yield* agent.send(session, "Again")
      return { reply, again, tried: yield* Ref.get(tried), requests: (yield* agent.inspect(session)).requests.map((request) => request.system) }
    })))
    expect(result.tried).toEqual(["InsideTurn", "InsideTurn"])
    expect(result.reply).toEqual({ text: "Fine." })
    expect(result.again).toEqual({ text: "Fine." })
    expect(result.requests).toEqual([system, system])
  })

  test("type-level: storage and sessions are not among the changes it takes", () => {
    const changes = (agent: AgentHandle) => [
      agent.with({ system: "Other." }),
      // @ts-expect-error storage stays the agent's own: `with` takes model, system, memory, loop and plugins
      agent.with({ storage: inMemoryStorage() }),
    ]
    // Nothing runs here: the claim is the compiler's, held by the directive above.
    expect(changes).toBeFunction()
  })
})
