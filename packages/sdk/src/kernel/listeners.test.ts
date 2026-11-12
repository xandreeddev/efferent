import { describe, expect, test } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Queue, Ref, Schema, Scope, Stream } from "effect"
import { Core, listenerFailedEvent, requestSentEvent, turnEndedEvent, turnStartedEvent, userMessageEvent } from "@xandreed/core/kernel"
import type { Settings } from "@xandreed/core/kernel"
import type { SessionsOptions } from "./index.js"
import { answering, inOrder, open, recording, stack } from "./testing.js"
const FIVE = ["plugin.session.turn.started", "plugin.loop.user.message", "plugin.loop.request.sent", "plugin.loop.assistant.message", "plugin.session.turn.ended"]

class AuditFailed extends Schema.TaggedError<AuditFailed>()("AuditFailed", { message: Schema.String }) {}

/**
 * An agent with one extra plugin, and beside it: the reports of failed
 * listeners as they arrive (they are never waited for, so a test takes them
 * from a queue), and the session's starts and ends as their listeners saw them.
 */
const agentWith = (extra: Layer.Layer<never, never, Core | Settings>, options: SessionsOptions = {}) => Effect.gen(function* () {
  const { model, received } = yield* answering("Hi.")
  const reports = yield* Queue.unbounded<unknown>()
  const reporter = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(listenerFailedEvent, (failure) => Queue.offer(reports, failure.data), { name: "reports" })))
  const turns = yield* recording([turnStartedEvent, turnEndedEvent])
  const agent = yield* open(stack(model, { sessions: options, extras: inOrder(turns.layer, extra, reporter) }))
  const session = yield* agent.createSession({ owner: "learner" })
  const names = Effect.map(agent.inspect(session), (inspection) => inspection.events.map((event): string => event.name))
  const announced = Effect.map(turns.seen, (seen) => seen.map((event) => event._tag === "Stored" ? Number(event.seq) : 0))
  return { ...agent, session, received, report: Queue.take(reports), names, announced }
})

describe("a listener the publisher waits for", () => {
  test("holds the turn until it is done: the event is stored, and nothing after it happens", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const slow = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(userMessageEvent, () => Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)), { wait: true, name: "slow" })))
      const kernel = yield* agentWith(slow)
      const turn = yield* Effect.forkChild(kernel.send(kernel.session, "Hello"))
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
      const stuck = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(userMessageEvent, () => Effect.never, { name: "stuck" })))
      const kernel = yield* agentWith(stuck)
      return { reply: yield* kernel.send(kernel.session, "Hello"), again: yield* kernel.send(kernel.session, "Again") }
    })))
    expect(result).toEqual({ reply: { text: "Hi." }, again: { text: "Hi." } })
  })

  test("when it fails, the turn fails with the listener and the event named, and still closes", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const audit = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(requestSentEvent, () => Effect.flatMap(Ref.updateAndGet(calls, (count) => count + 1), (count) =>
          count === 1 ? Effect.fail(new AuditFailed({ message: "the audit log is full" })) : Effect.void), { wait: true, name: "audit" })))
      const kernel = yield* agentWith(audit)
      const failed = yield* Effect.flip(kernel.send(kernel.session, "Hello"))
      const afterFailure = { names: yield* kernel.names, inspection: yield* kernel.inspect(kernel.session), calls: (yield* kernel.received).length }
      const reply = yield* kernel.send(kernel.session, "Again")
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

describe("a listener the publisher waits for, that ends with an interrupt it was not sent", () => {
  test("fails the turn with ListenerFailed, which ends Failed, not Interrupted, and the next send works", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      // On the first request, the handler awaits a deferred that was interrupted: nobody interrupted the turn.
      const audit = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(requestSentEvent, () => Effect.flatMap(Ref.updateAndGet(calls, (count) => count + 1), (count) =>
        count === 1 ? Effect.flatMap(Deferred.make<void>(), (gone) => Effect.andThen(Deferred.interrupt(gone), Deferred.await(gone))) : Effect.void), { wait: true, name: "audit" })))
      const kernel = yield* agentWith(audit)
      const failed = yield* Effect.exit(kernel.send(kernel.session, "Hello"))
      const inspection = yield* kernel.inspect(kernel.session)
      return { interrupted: Exit.hasInterrupts(failed), failed: Exit.isFailure(failed) ? Cause.squash(failed.cause) : failed, ended: inspection.events.at(-1)?.data, reply: yield* kernel.send(kernel.session, "Again") }
    }).pipe(Effect.timeout("5 seconds"))))
    expect(result.interrupted).toBe(false)
    expect(result.failed).toMatchObject({ _tag: "ListenerFailed", listener: "audit", event: "plugin.loop.request.sent", message: "interrupted" })
    expect(result.ended).toEqual({ turn: 1, outcome: { _tag: "Failed", reason: "ListenerFailed: interrupted" } })
    expect(result.reply).toEqual({ text: "Hi." })
  })
})

describe("a listener the publisher waits for, on the turn's start", () => {
  test("that fails fails the turn, which still closes, and the next send works", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const starts = yield* Ref.make(0)
      const gate = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(turnStartedEvent, () => Effect.flatMap(Ref.updateAndGet(starts, (count) => count + 1), (count) =>
          count === 1 ? Effect.fail(new AuditFailed({ message: "not now" })) : Effect.void), { wait: true, name: "gate" })))
      const kernel = yield* agentWith(gate)
      const failed = yield* Effect.flip(kernel.send(kernel.session, "Hello"))
      const afterFailure = { names: yield* kernel.names, inspection: yield* kernel.inspect(kernel.session) }
      const reply = yield* kernel.send(kernel.session, "Again")
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
  test("that fails leaves the caller with its reply and the session free, and is reported as core.listener.failed", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const audit = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => Effect.fail(new AuditFailed({ message: "the audit log is full" })), { wait: true, name: "audit" })))
      const kernel = yield* agentWith(audit)
      const reply = yield* kernel.send(kernel.session, "Hello")
      const state = (yield* kernel.inspect(kernel.session)).state
      const report = yield* kernel.report
      const again = yield* kernel.send(kernel.session, "Again")
      return { reply, state, report, again, names: yield* kernel.names }
    })))
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.state).toEqual({ _tag: "Free", turns: 1 })
    expect(result.report).toEqual({ listener: "audit", event: "plugin.session.turn.ended", reason: "AuditFailed: the audit log is full" })
    expect(result.again).toEqual({ text: "Hi." })
    expect(result.names).toEqual([...FIVE, ...FIVE])
  })

  test("that never returns is cut short after closeWait and reported: the caller gets its reply and the session takes the next turn", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const stuck = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => Effect.never, { wait: true, name: "stuck" })))
      const kernel = yield* agentWith(stuck, { closeWait: "20 millis" })
      const reply = yield* kernel.send(kernel.session, "Hello")
      const state = (yield* kernel.inspect(kernel.session)).state
      const again = yield* kernel.send(kernel.session, "Again")
      return { reply, state, again, reports: [yield* kernel.report, yield* kernel.report], names: yield* kernel.names }
    })))
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.state).toEqual({ _tag: "Free", turns: 1 })
    expect(result.again).toEqual({ text: "Hi." })
    expect(result.reports).toEqual([
      { listener: "stuck", event: "plugin.session.turn.ended", reason: "interrupted before it finished" },
      { listener: "stuck", event: "plugin.session.turn.ended", reason: "interrupted before it finished" },
    ])
    expect(result.names).toEqual([...FIVE, ...FIVE])
  })

  test("that cannot be interrupted is cut short after closeWait all the same: send returns, the session takes the next turn, and it is reported", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const deaf = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => Effect.uninterruptible(Effect.never), { wait: true, name: "deaf" })))
      const kernel = yield* agentWith(deaf, { closeWait: "20 millis" })
      const reply = yield* kernel.send(kernel.session, "Hello")
      const again = yield* kernel.send(kernel.session, "Again")
      return { reply, again, reports: [yield* kernel.report, yield* kernel.report], names: yield* kernel.names }
      // Two seconds for the whole of it: code that waits on the listener fails here, and does not hang the run.
    })).pipe(Effect.timeout("2 seconds")))
    expect(result.reply).toEqual({ text: "Hi." })
    expect(result.again).toEqual({ text: "Hi." })
    expect(result.reports).toEqual([
      { listener: "deaf", event: "plugin.session.turn.ended", reason: "interrupted before it finished" },
      { listener: "deaf", event: "plugin.session.turn.ended", reason: "interrupted before it finished" },
    ])
    expect(result.names).toEqual([...FIVE, ...FIVE])
  })

  test("in the background that cannot be interrupted does not hold the close of the stack", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const { model } = yield* answering("Hi.")
      const entered = yield* Deferred.make<void>()
      const deaf = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.uninterruptible(Effect.never)), { name: "deaf" })))
      const scope = yield* Scope.make()
      const agent = yield* open(stack(model, { extras: deaf })).pipe(Scope.provide(scope))
      const session = yield* agent.createSession({ owner: "learner" })
      const reply = yield* agent.send(session, "Hello")
      yield* Deferred.await(entered)
      // The listener is running and cannot be interrupted: closing the stack, its listeners removed, does not wait for it.
      yield* Scope.close(scope, Exit.void)
      return reply
    })).pipe(Effect.timeout("2 seconds")))
    expect(result).toEqual({ text: "Hi." })
  })

  test("holds the session, not an interrupted caller: the next turn waits for the end to be announced, so events arrive in journal order", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const go = yield* Deferred.make<void>()
      const ends = yield* Ref.make(0)
      // The listener holds the first turn's end until it is let go.
      const slow = Layer.effectDiscard(Effect.flatMap(Core, (core) => core.on(turnEndedEvent, () => Effect.flatMap(Ref.updateAndGet(ends, (count) => count + 1), (count) =>
          count === 1 ? Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(go)) : Effect.void), { wait: true, name: "slow" })))
      const kernel = yield* agentWith(slow, { closeWait: "1 minute" })
      // The first turn's end as the host's stream hands it over: the session is free by then.
      const handedOver = yield* Effect.forkScoped(Stream.runHead(Stream.filter(kernel.events, (event) => event.name === turnEndedEvent.name)), { startImmediately: true })
      const first = yield* Effect.forkChild(kernel.send(kernel.session, "Hello"))
      yield* Deferred.await(entered)
      // The end is stored and being announced: the journal says the turn is over, and the session is still busy.
      const stored = (yield* kernel.inspect(kernel.session)).state
      const refused = yield* Effect.flip(kernel.send(kernel.session, "Too soon"))
      // A caller that is interrupted stops waiting at once; the announcement goes on without it.
      yield* Fiber.interrupt(first)
      const stillBusy = yield* Effect.flip(kernel.send(kernel.session, "Still too soon"))
      yield* Deferred.succeed(go, undefined)
      // Once the listener is done the end goes to the stream, and the session is free in the same step: no retry.
      yield* Fiber.join(handedOver)
      const again = yield* kernel.send(kernel.session, "Again")
      return { stored, refused, stillBusy, again, names: yield* kernel.names, announced: yield* kernel.announced }
    })))
    expect(result.stored).toEqual({ _tag: "Free", turns: 1 })
    expect(result.refused).toMatchObject({ _tag: "SessionRefused", reason: "SessionBusy" })
    expect(result.stillBusy).toMatchObject({ _tag: "SessionRefused", reason: "SessionBusy" })
    expect(result.again).toEqual({ text: "Hi." })
    expect(result.names).toEqual([...FIVE, ...FIVE])
    // The first turn's end reached the listeners before the second turn's start: the places are in journal order.
    expect(result.announced).toEqual([1, 5, 6, 10])
  })
})
