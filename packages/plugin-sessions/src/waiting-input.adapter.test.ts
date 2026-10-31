import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { awaitIdle, ConversationId, InboxItemId, SessionLog, SessionLogError, SessionLogMemoryLive, Sessions, shutdownGracefully, TurnAdmissionOpen, UserMessage, WaitingInput } from "@xandreed/core"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"

const address = { id: ConversationId.make("00000000-0000-4000-8000-000000005531"), owner: "waiting-input" }
const queued = { id: InboxItemId.make("retained"), delivery: "next" as const, source: {}, userMessage: new UserMessage({ text: "Keep this request." }) }

test("a failed queue refresh preserves cached backlog and shutdown performs no fresh queue read", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const log = yield* Layer.build(SessionLogMemoryLive).pipe(Effect.map((context) => Context.get(context, SessionLog)))
  const unavailable = yield* Ref.make(false)
  const failure = new SessionLogError({ code: "store.unavailable", message: "scripted storage outage" })
  const guarded = SessionLog.of({ ...log, head: (id) => Ref.get(unavailable).pipe(Effect.flatMap((failed) => failed ? Effect.fail(failure) : log.head(id))) })
  const context = yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, guarded), TurnAdmissionOpen))))
  const sessions = Context.get(context, Sessions)
  const probe = Context.get(context, WaitingInput)
  yield* sessions.create(address)
  yield* sessions.enqueue(address, queued)
  expect(yield* probe.current).toEqual([{ session: address.id, pending: 1 }])
  yield* Ref.set(unavailable, true)
  expect(yield* Effect.flip(probe.current)).toBe(failure)
  expect(yield* probe.cached).toEqual([{ session: address.id, pending: 1 }])
  expect(yield* awaitIdle({ queued: false }).pipe(Effect.provide(context))).toMatchObject({ busy: true, inFlight: false, queuedInput: 1 })
  expect(yield* shutdownGracefully({ deadline: 0 }).pipe(Effect.provide(context))).toMatchObject({ idle: true, left: { busy: true, inFlight: false, queuedInput: 1 } })
}))))

test("observing raw history keeps reads available when head state does not decode, while queue activity fails honestly", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const log = yield* Layer.build(SessionLogMemoryLive).pipe(Effect.map((context) => Context.get(context, SessionLog)))
  const context = yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen))))
  const sessions = Context.get(context, Sessions)
  const probe = Context.get(context, WaitingInput)
  yield* sessions.create(address)
  yield* sessions.enqueue(address, queued)
  expect(yield* probe.current).toEqual([{ session: address.id, pending: 1 }])
  const before = yield* sessions.read(address)
  const head = yield* log.head(address.id)
  yield* log.commit(address.id, { expect: head.revision, notAfter: Option.none(), events: [], state: Option.some({ sessions: { invalid: true } }) })
  expect(yield* sessions.read(address)).toEqual(before)
  expect(yield* Effect.flip(probe.current)).toMatchObject({ _tag: "SessionLogError", code: "session.state" })
  expect(yield* probe.cached).toEqual([{ session: address.id, pending: 1 }])
}))))

const ackOperations = ["enqueue", "create", "fork", "remove"] as const
ackOperations.map((operation) => test(`an interrupted ${operation} acknowledges its durable change to waiting subscribers`, () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const log = yield* Layer.build(SessionLogMemoryLive).pipe(Effect.map((context) => Context.get(context, SessionLog)))
  const block = yield* Ref.make(false)
  const persisted = yield* Deferred.make<void>()
  const acknowledge = yield* Deferred.make<void>()
  const afterStore = Ref.get(block).pipe(Effect.flatMap((blocked) => blocked
    ? Deferred.succeed(persisted, undefined).pipe(Effect.andThen(Deferred.await(acknowledge))) : Effect.void))
  const controlled = SessionLog.of({
    ...log,
    commit: (id, input) => log.commit(id, input).pipe(Effect.tap(() => afterStore)),
    create: (header) => log.create(header).pipe(Effect.tap(() => afterStore)),
    remove: (id) => log.remove(id).pipe(Effect.tap(() => afterStore)),
  })
  const context = yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, controlled), TurnAdmissionOpen))))
  const sessions = Context.get(context, Sessions)
  const probe = Context.get(context, WaitingInput)
  yield* sessions.create(address)
  if (operation === "remove") yield* sessions.enqueue(address, queued)
  const initial = yield* Deferred.make<void>()
  const changed = yield* Deferred.make<void>()
  const signals = yield* Ref.make(0)
  yield* sessions.waiting.pipe(Stream.runForEach(() => Ref.updateAndGet(signals, (count) => count + 1).pipe(
    Effect.flatMap((count) => Deferred.succeed(count === 1 ? initial : changed, undefined)),
  )), Effect.forkScoped)
  yield* Deferred.await(initial)
  yield* Ref.set(block, true)
  const childId = ConversationId.make("00000000-0000-4000-8000-000000005532")
  const action = operation === "enqueue" ? sessions.enqueue(address, queued).pipe(Effect.asVoid)
    : operation === "create" ? sessions.create({ ...address, id: childId }).pipe(Effect.asVoid)
      : operation === "fork" ? sessions.fork(address, { id: childId, origin: "test", inherit: false }).pipe(Effect.asVoid)
        : sessions.remove(address)
  const caller = yield* Effect.forkChild(action)
  yield* Deferred.await(persisted)
  yield* Effect.sync(() => caller.interruptUnsafe())
  yield* Deferred.succeed(acknowledge, undefined)
  yield* Fiber.await(caller)
  expect(Option.isSome(yield* Deferred.await(changed).pipe(Effect.timeoutOption("200 millis")))).toBe(true)
  expect(yield* probe.cached).toEqual(operation === "enqueue" ? [{ session: address.id, pending: 1 }] : [])
})).pipe(Effect.timeout("3 seconds")))))
