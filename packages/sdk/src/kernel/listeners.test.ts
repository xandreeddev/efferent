import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Ref, Schema } from "effect"
import { Core, definePlugin, listenerFailedEvent, requestSentEvent, turnEndedEvent, turnStartedEvent, userMessageEvent } from "@xandreed/core/kernel"
import type { Plugin } from "@xandreed/core/kernel"
import { Agent, inMemoryStorage, sessions, windowMemory } from "./index.js"
import type { SessionsOptions } from "./index.js"
import { answering, recording } from "./testing.js"

const system = "You are a friendly tutor."
const FIVE = ["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.loop.assistant.message", "plugin.session.turn.ended"]

class AuditFailed extends Schema.TaggedError<AuditFailed>()("AuditFailed", { message: Schema.String }) {}

/** An agent with one extra plugin beside a recorder of `core.listener.failed`. */
const agentWith = (extra: Plugin<never, never, Core>, options: SessionsOptions = {}) => Effect.gen(function* () {
  const { model, received } = yield* answering("Hi.")
  const failures = yield* recording([listenerFailedEvent])
  const agent = yield* Agent.define({ model, system, storage: inMemoryStorage(), sessions: sessions(options), memory: windowMemory({ budgetTokens: 3000 }), plugins: [extra, failures.plugin] })
  const session = yield* agent.createSession({ owner: "learner" })
  const names = Effect.map(agent.inspect(session), (inspection) => inspection.events.map((event): string => event.name))
  return { agent, session, received, failures: failures.seen, names }
})

describe("a listener the publisher waits for", () => {
  test("holds the turn until it is done: the event is stored, and nothing after it happens", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const slow = definePlugin({
        name: "slow",
        make: Effect.flatMap(Core, (core) => core.on(userMessageEvent, () => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)), { wait: true })),
      })
      const kernel = yield* agentWith(slow)
      const turn = yield* Effect.forkChild(kernel.agent.send(kernel.session, "Hello"))
      yield* Deferred.await(entered)
      const during = { names: yield* kernel.names, calls: (yield* kernel.received).length }
      yield* Deferred.succeed(go, undefined)
      const reply = yield* Fiber.join(turn)
      return { during, reply, names: yield* kernel.names }
    })))
    expect(result.during).toEqual({ names: ["plugin.session.turn.started", "plugin.loop.user.message"], calls: 0 })
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.names).toEqual(FIVE)
  })

  test("a background listener that never returns holds nothing", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const stuck = definePlugin({ name: "stuck", make: Effect.flatMap(Core, (core) => core.on(userMessageEvent, () => Effect.never)) })
      const kernel = yield* agentWith(stuck)
      return { reply: yield* kernel.agent.send(kernel.session, "Hello"), again: yield* kernel.agent.send(kernel.session, "Again") }
    })))
    expect(result).toEqual({ reply: { text: "Hi." }, again: { text: "Hi." } })
  })

  test("when it fails, the turn fails with the listener and the event named, and still closes", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const audit = definePlugin({
        name: "audit",
        make: Effect.flatMap(Core, (core) => core.on(requestSentEvent, () => Effect.flatMap(Ref.updateAndGet(calls, (count) => count + 1), (count) =>
          count === 1 ? Effect.fail(new AuditFailed({ message: "the audit log is full" })) : Effect.void), { wait: true })),
      })
      const kernel = yield* agentWith(audit)
      const failed = yield* Effect.flip(kernel.agent.send(kernel.session, "Hello"))
      const afterFailure = { names: yield* kernel.names, inspection: yield* kernel.agent.inspect(kernel.session), calls: (yield* kernel.received).length }
      const reply = yield* kernel.agent.send(kernel.session, "Again")
      return { failed, afterFailure, reply, names: yield* kernel.names }
    })))
    expect(result.failed).toMatchObject({ _tag: "ListenerFailed", listener: "audit", event: "plugin.loop.request.sent", message: "AuditFailed: the audit log is full" })
    // The request was stored before it was announced; the model was never called; the turn closed as failed.
    expect(result.afterFailure.names).toEqual(["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.session.turn.ended"])
    expect(result.afterFailure.calls).toBe(0)
    expect(result.afterFailure.inspection.events.at(-1)?.data).toEqual({ turn: 1, outcome: { _tag: "Failed", reason: "ListenerFailed: AuditFailed: the audit log is full" } })
    expect(result.afterFailure.inspection.state).toEqual({ _tag: "Free", turns: 1 })
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.names.slice(4)).toEqual(FIVE)
  })
})

describe("a listener the publisher waits for, on the turn's start", () => {
  test("that fails fails the turn, which still closes, and the next send works", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const starts = yield* Ref.make(0)
      const gate = definePlugin({
        name: "gate",
        make: Effect.flatMap(Core, (core) => core.on(turnStartedEvent, () => Effect.flatMap(Ref.updateAndGet(starts, (count) => count + 1), (count) =>
          count === 1 ? Effect.fail(new AuditFailed({ message: "not now" })) : Effect.void), { wait: true })),
      })
      const kernel = yield* agentWith(gate)
      const failed = yield* Effect.flip(kernel.agent.send(kernel.session, "Hello"))
      const afterFailure = { names: yield* kernel.names, inspection: yield* kernel.agent.inspect(kernel.session) }
      const reply = yield* kernel.agent.send(kernel.session, "Again")
      return { failed, afterFailure, reply, names: yield* kernel.names }
    })))
    expect(result.failed).toMatchObject({ _tag: "ListenerFailed", listener: "gate", event: "plugin.session.turn.started" })
    // The start is announced inside the turn: the body never ran, and the turn closed as failed and freed the session.
    expect(result.afterFailure.names).toEqual(["plugin.session.turn.started", "plugin.session.turn.ended"])
    expect(result.afterFailure.inspection.events.at(-1)?.data).toEqual({ turn: 1, outcome: { _tag: "Failed", reason: "ListenerFailed: AuditFailed: not now" } })
    expect(result.afterFailure.inspection.state).toEqual({ _tag: "Free", turns: 1 })
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.names.slice(2)).toEqual(FIVE)
  })
})

describe("a listener on the turn's end", () => {
  test("that fails leaves the session free, the caller with its reply, and is reported as core.listener.failed", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const audit = definePlugin({
        name: "audit",
        make: Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => Effect.fail(new AuditFailed({ message: "the audit log is full" })), { wait: true })),
      })
      const kernel = yield* agentWith(audit)
      const reply = yield* kernel.agent.send(kernel.session, "Hello")
      const state = (yield* kernel.agent.inspect(kernel.session)).state
      const failures = yield* kernel.failures
      const again = yield* kernel.agent.send(kernel.session, "Again")
      return { reply, state, failures, again, names: yield* kernel.names }
    })))
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.state).toEqual({ _tag: "Free", turns: 1 })
    expect(result.failures.map((event) => [event._tag, event.name, event.turn, event.data])).toEqual([
      ["Live", "core.listener.failed", 1, { listener: "audit", event: "plugin.session.turn.ended", reason: "AuditFailed: the audit log is full" }],
    ])
    expect(result.again).toEqual({ text: "Hi." })
    expect(result.names).toEqual([...FIVE, ...FIVE])
  })

  test("that never returns is cut short and reported: the caller gets its reply and the session takes the next turn", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const stuck = definePlugin({ name: "stuck", make: Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => Effect.never, { wait: true })) })
      const kernel = yield* agentWith(stuck, { closeWait: "20 millis" })
      const reply = yield* kernel.agent.send(kernel.session, "Hello")
      const state = (yield* kernel.agent.inspect(kernel.session)).state
      const again = yield* kernel.agent.send(kernel.session, "Again")
      return { reply, state, again, failures: yield* kernel.failures, names: yield* kernel.names }
    })))
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.state).toEqual({ _tag: "Free", turns: 1 })
    expect(result.again).toEqual({ text: "Hi." })
    expect(result.failures.map((event) => event.data)).toEqual([
      { listener: "stuck", event: "plugin.session.turn.ended", reason: "interrupted before it finished" },
      { listener: "stuck", event: "plugin.session.turn.ended", reason: "interrupted before it finished" },
    ])
    expect(result.names).toEqual([...FIVE, ...FIVE])
  })

  test("that hangs does not keep the session busy while it hangs", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const ends = yield* Ref.make(0)
      // The listener hangs on the first turn's end only.
      const stuck = definePlugin({
        name: "stuck",
        make: Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => Effect.flatMap(Ref.updateAndGet(ends, (count) => count + 1), (count) =>
          count === 1 ? Effect.andThen(Deferred.succeed(entered, undefined), Effect.never) : Effect.void), { wait: true })),
      })
      const kernel = yield* agentWith(stuck, { closeWait: "1 minute" })
      const first = yield* Effect.forkChild(kernel.agent.send(kernel.session, "Hello"))
      yield* Deferred.await(entered)
      // The first send is still waiting for the listener; the session is free already, and takes a whole turn.
      const state = (yield* kernel.agent.inspect(kernel.session)).state
      const again = yield* kernel.agent.send(kernel.session, "Again")
      // An interrupted caller stops waiting at once.
      yield* Fiber.interrupt(first)
      return { state, again, names: yield* kernel.names }
    })))
    expect(result.again).toEqual({ text: "Hi." })
    expect(result.state).toEqual({ _tag: "Free", turns: 1 })
    expect(result.names).toEqual([...FIVE, ...FIVE])
  })
})
