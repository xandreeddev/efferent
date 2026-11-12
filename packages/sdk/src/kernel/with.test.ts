import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Option, Predicate, Ref, Stream } from "effect"
import { assistantMessageEvent, Core, definePlugin, estimateRequest, Memory, messageOf, requestSentEvent, Settings, Tokens, turnEndedEvent, turnMessageOf, userMessageEvent } from "@xandreed/core/kernel"
import type { AgentHandle } from "./index.js"
import { Agent, inProcessJournal, sessions, windowMemory, windowPressureEvent } from "./index.js"
import { answer, answering, scripted } from "./testing.js"

const system = "You are a friendly tutor."
const FIVE = ["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.loop.assistant.message", "plugin.session.turn.ended"]

/** A memory that sends only the message the turn answers, and counts the requests it hears of. */
const forgetful = (heard: Ref.Ref<number>) => definePlugin({
  name: "forgetful",
  requires: [Core, Settings],
  provides: Memory,
  make: Effect.gen(function* () {
    const core = yield* Core
    const settings = yield* Settings
    yield* core.on(requestSentEvent, () => Ref.update(heard, (count) => count + 1), { wait: true })
    return Memory.of({
      build: (session) => Effect.map(session.journal, (journal) => {
        const asked = Option.toArray(turnMessageOf(journal))
        const messages = journal.filter((event) => asked.includes(event.seq)).flatMap((event) => Option.toArray(messageOf(event)))
        return { messages: asked, estimatedTokens: estimateRequest(settings.system, messages), budgetTokens: Tokens.make(3000) }
      }),
    })
  }),
})

/** An extra plugin that counts, while the publisher waits, the assistant messages it hears: what it has counted when `send` returns is exact. */
const counting = (heard: Ref.Ref<number>, name = "counter") => definePlugin({
  name,
  requires: [Core],
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
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: forgetful(heard) })
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
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory, plugins: [counting(heard)] })
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

  test("waits for the turn the agent is running: it returns only after that turn ended, and refuses a send and a second with meanwhile", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const model = yield* gated
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const note = (line: string) => Ref.update(order, (all) => [...all, line])
      const watch = definePlugin({ name: "watch", requires: [Core], make: Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => note("the turn ended"), { wait: true })) })
      // No part of this agent listens in the background: while the model thinks nothing is under way but the turn itself.
      const agent = yield* Agent.define({ model: model.model, system, storage: inProcessJournal(), memory: forgetful(yield* Ref.make(0)), plugins: [watch] })
      const session = yield* agent.createSession({ owner: "learner" })
      const other = yield* agent.createSession({ owner: "learner" })
      const running = yield* Effect.forkChild(agent.send(session, "One"))
      yield* model.asked
      // Started at once: it has marked the handle and is waiting for the turn.
      const replacing = yield* Effect.forkChild(Effect.tap(agent.with({ plugins: [] }), () => note("replaced")), { startImmediately: true })
      const refusedSend = yield* Effect.flip(agent.send(other, "Too soon"))
      const refusedWith = yield* Effect.flip(agent.with({ system: "Other." }))
      yield* note("the model is let go")
      yield* model.go
      const first = yield* Fiber.join(running)
      const next = yield* Fiber.join(replacing)
      const second = yield* next.send(other, "Two")
      const late = yield* Effect.flip(agent.send(other, "Too late"))
      return { refusedSend, refusedWith, first, second, late, order: yield* Ref.get(order) }
    })))
    expect(result.refusedSend).toMatchObject({ _tag: "AgentRefused", reason: "Replacing" })
    expect(result.refusedWith).toMatchObject({ _tag: "AgentRefused", reason: "Replacing" })
    expect(result.first).toEqual({ text: "First." })
    expect(result.second).toEqual({ text: "Later." })
    expect(result.late).toMatchObject({ _tag: "AgentRefused", reason: "Replaced" })
    // `with` returned after the old turn's end, and the successor's turn was not heard by the old agent's listener.
    expect(result.order).toEqual(["the model is let go", "the turn ended", "replaced"])
  })

  test("no event reaches the listeners of both agents: with a turn running on one session and the extras kept, a request of the successor on another is counted once and presses once", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const model = yield* gated
      const requests = yield* Ref.make(0)
      const pressures = yield* Ref.make(0)
      // Kept by `with`: the same two plugins before and after, each built again for the successor.
      const extras = [
        definePlugin({ name: "requests", requires: [Core], make: Effect.flatMap(Core, (core) => core.on(requestSentEvent, () => Ref.update(requests, (count) => count + 1), { wait: true })) }),
        definePlugin({ name: "pressures", requires: [Core], make: Effect.flatMap(Core, (core) => core.on(windowPressureEvent, () => Ref.update(pressures, (count) => count + 1), { wait: true })) }),
      ]
      // Every request presses: the window memory announces it from a background listener of its own.
      const agent = yield* Agent.define({ model: model.model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000, pressureAt: 0.001 }), plugins: extras })
      const sessionA = yield* agent.createSession({ owner: "learner" })
      const sessionB = yield* agent.createSession({ owner: "learner" })
      const running = yield* Effect.forkChild(agent.send(sessionA, "One"))
      yield* model.asked
      const replacing = yield* Effect.forkChild(agent.with({ system: "Second." }), { startImmediately: true })
      yield* model.go
      yield* Fiber.join(running)
      const next = yield* Fiber.join(replacing)
      // Everything the first turn published was handled before the old listeners went: its request, and its pressure.
      const afterOld = [yield* Ref.get(requests), yield* Ref.get(pressures)]
      yield* next.send(sessionB, "Two")
      // Replacing again waits until every listener has handled what that turn published.
      yield* next.with({})
      return { afterOld, atEnd: [yield* Ref.get(requests), yield* Ref.get(pressures)] }
    })))
    expect(result.afterOld).toEqual([1, 1])
    expect(result.atEnd).toEqual([2, 2])
  })

  test("the agent's listeners hear every event of its last turn, the end included, before they are removed", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Fine.")
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      const go = yield* Deferred.make<void>()
      // Background listeners that are held: each takes up its event and writes it down only when the test lets it.
      const held = definePlugin({
        name: "held",
        requires: [Core],
        make: Effect.gen(function* () {
          const core = yield* Core
          const note = (line: string) => Effect.andThen(Deferred.await(go), Ref.update(heard, (all) => [...all, line]))
          yield* core.on(userMessageEvent, () => note("the message"))
          yield* core.on(assistantMessageEvent, () => note("the answer"))
          yield* core.on(turnEndedEvent, () => note("the end"))
        }),
      })
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [held] })
      const session = yield* agent.createSession({ owner: "learner" })
      yield* agent.send(session, "One")
      // The turn is over and its listeners have written nothing. `with` is started, and only then are they let go.
      const atReturn = yield* Ref.get(heard)
      const replacing = yield* Effect.forkChild(agent.with({ plugins: [] }), { startImmediately: true })
      yield* Deferred.succeed(go, undefined)
      const next = yield* Fiber.join(replacing)
      const atSwitch = yield* Ref.get(heard)
      yield* next.send(session, "Two")
      yield* next.with({})
      return { atReturn, atSwitch, atEnd: yield* Ref.get(heard) }
    })))
    expect(result.atReturn).toEqual([])
    expect(result.atSwitch).toEqual(["the message", "the answer", "the end"])
    // They were removed with their agent: the successor's turn reached none of them.
    expect(result.atEnd).toEqual(["the message", "the answer", "the end"])
  })

  test("after a send whose caller was interrupted, the end of its turn still reaches the agent's listeners, waited for and in the background, before they are removed", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Fine.")
      const heard = yield* Ref.make<ReadonlyArray<string>>([])
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const ends = definePlugin({
        name: "ends",
        requires: [Core],
        make: Effect.gen(function* () {
          const core = yield* Core
          // The announcement of the end waits here; the hub, and so the background listener, has it only after.
          yield* core.on(turnEndedEvent, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(go)), Effect.andThen(Ref.update(heard, (all) => [...all, "waited for"]))), { wait: true })
          yield* core.on(turnEndedEvent, () => Effect.andThen(Effect.sleep("10 millis"), Ref.update(heard, (all) => [...all, "in the background"])))
        }),
      })
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), sessions: sessions({ closeWait: "1 minute" }), memory: windowMemory({ budgetTokens: 3000 }), plugins: [ends] })
      const session = yield* agent.createSession({ owner: "learner" })
      const sending = yield* Effect.forkChild(agent.send(session, "One"))
      yield* Deferred.await(entered)
      // The caller stops waiting: its turn has left the handle, and the end is still being announced.
      yield* Fiber.interrupt(sending)
      const replacing = yield* Effect.forkChild(agent.with({ plugins: [] }), { startImmediately: true })
      yield* Deferred.succeed(go, undefined)
      const next = yield* Fiber.join(replacing)
      return { heard: yield* Ref.get(heard), reply: yield* next.send(session, "Two") }
    })))
    expect(result.heard).toEqual(["waited for", "in the background"])
    expect(result.reply).toEqual({ text: "Fine." })
  })

  test("interrupted while it waits for a turn, it changes nothing: a send that was refused during the wait works again", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const model = yield* gated
      const agent = yield* Agent.define({ model: model.model, system, storage: inProcessJournal(), memory: forgetful(yield* Ref.make(0)) })
      const session = yield* agent.createSession({ owner: "learner" })
      const other = yield* agent.createSession({ owner: "learner" })
      const running = yield* Effect.forkChild(agent.send(session, "One"))
      yield* model.asked
      const replacing = yield* Effect.forkChild(agent.with({ system: "Other." }), { startImmediately: true })
      const during = yield* Effect.flip(agent.send(other, "Too soon"))
      yield* Fiber.interrupt(replacing)
      const after = yield* agent.send(other, "Now")
      yield* model.go
      const first = yield* Fiber.join(running)
      // And it can be replaced after all.
      const next = yield* agent.with({ system: "Other." })
      return { during, after, first, later: yield* next.send(other, "Again"), systems: (yield* next.inspect(other)).requests.map((request) => request.system) }
    })))
    expect(result.during).toMatchObject({ _tag: "AgentRefused", reason: "Replacing" })
    expect(result.after).toEqual({ text: "Later." })
    expect(result.first).toEqual({ text: "First." })
    expect(result.later).toEqual({ text: "Later." })
    expect(result.systems).toEqual([system, "Other."])
  })

  test("a change given as undefined is no change", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model, received } = yield* answering("Fine.")
      const heard = yield* Ref.make(0)
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [counting(heard)] })
      const session = yield* agent.createSession({ owner: "learner" })
      // What a caller without the types can write: every key there, none with a value.
      const nothing: Record<string, undefined> = { model: undefined, system: undefined, memory: undefined, loop: undefined, plugins: undefined }
      const next = yield* agent.with(nothing)
      const reply = yield* next.send(session, "One")
      return { reply, heard: yield* Ref.get(heard), received: yield* received }
    })))
    expect(result.reply).toEqual({ text: "Fine." })
    expect(result.heard).toBe(1)
    expect(result.received).toEqual([[{ role: "system", text: system }, { role: "user", text: "One" }]])
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
        requires: [Core],
        make: Effect.gen(function* () {
          const core = yield* Core
          yield* core.on(userMessageEvent, () => Ref.update(strayHeard, (count) => count + 1), { wait: true })
          yield* Effect.addFinalizer(() => Ref.set(released, true))
        }),
      })
      // And one built after it, which never finishes building.
      const slow = definePlugin({ name: "slow", requires: [], make: Effect.andThen(Deferred.succeed(building, undefined), Effect.never) })
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }) })
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
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }) })
      const session = yield* agent.createSession({ owner: "learner" })
      const failed = yield* Effect.flip(agent.with({ memory: windowMemory({ budgetTokens: Number.NaN }) }))
      return { failed, reply: yield* agent.send(session, "Still there?") }
    })))
    expect(result.failed._tag).toBe("InvalidBudget")
    expect(result.reply).toEqual({ text: "Fine." })
  })

  test("called from inside a turn of the agent it would replace, it is refused at once and the turn goes on", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Fine.")
      const self = yield* Ref.make(Option.none<AgentHandle>())
      const tried = yield* Ref.make<ReadonlyArray<string>>([])
      // A listener the turn waits for tries to replace the agent the turn is running on.
      const meddler = definePlugin({
        name: "meddler",
        requires: [Core],
        make: Effect.flatMap(Core, (core) => core.on(userMessageEvent, () => Effect.flatMap(Ref.get(self), Option.match({
          onNone: () => Effect.void,
          onSome: (agent) => Effect.matchEffect(Effect.scoped(agent.with({ system: "Mine now." })), {
            onSuccess: () => Ref.update(tried, (all) => [...all, "replaced"]),
            onFailure: (error) => Ref.update(tried, (all) => [...all, Predicate.hasProperty(error, "reason") ? String(error.reason) : error._tag]),
          }),
        })), { wait: true })),
      })
      const agent = yield* Agent.define({ model, system, storage: inProcessJournal(), memory: windowMemory({ budgetTokens: 3000 }), plugins: [meddler] })
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
      agent.with({ storage: inProcessJournal() }),
    ]
    // Nothing runs here: the claim is the compiler's, held by the directive above.
    expect(changes).toBeFunction()
  })
})
