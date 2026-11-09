import { STORED_FORMAT } from "@xandreed/core"
import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { awaitIdle, ConversationId, InboxItemId, RunId, SessionLog, SessionLogError, SessionLogMemoryLive, Sessions, shutdownGracefully, TurnAdmissionOpen, UserMessage, WaitingInput } from "@xandreed/core"
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
  yield* Effect.gen(function* () { const sessionHead = yield* log.head(address.id); return yield* log.commit({ id: sessionHead.header.id, owner: sessionHead.header.owner, incarnation: sessionHead.incarnation }, { expect: head.revision, notAfter: Option.none(), events: [], state: Option.some({ sessions: { invalid: true, format: STORED_FORMAT } }) }) })
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
  yield* Deferred.await(changed)
  expect(yield* probe.cached).toEqual(operation === "enqueue" ? [{ session: address.id, pending: 1 }] : [])
})).pipe(Effect.timeout("3 seconds")))))

test("WaitingInput refreshes the sessions with waiting input and only the most recently observed quiet ones", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const log = yield* Layer.build(SessionLogMemoryLive).pipe(Effect.map((context) => Context.get(context, SessionLog)))
  const heads = yield* Ref.make<ReadonlyArray<string>>([])
  const counted = SessionLog.of({ ...log, head: (id) => Ref.update(heads, (all) => [...all, id]).pipe(Effect.andThen(log.head(id))) })
  const context = yield* Layer.build(SessionsLive({ ...sessionsDefaults, inbox: { ...sessionsDefaults.inbox, recentSessions: 2 } }).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, counted), TurnAdmissionOpen))))
  const sessions = Context.get(context, Sessions)
  const probe = Context.get(context, WaitingInput)
  const addresses = Array.from({ length: 6 }, (_, n) => ({ id: ConversationId.make(`00000000-0000-4000-8000-00000000560${n}`), owner: "bounded-observation" }))
  yield* Effect.forEach(addresses, (each) => sessions.create(each), { concurrency: 1, discard: true })
  yield* sessions.enqueue(addresses[0]!, queued)
  yield* Effect.forEach(addresses.slice(1), (each) => sessions.get(each), { concurrency: 1, discard: true })
  yield* Ref.set(heads, [])
  expect(yield* probe.current).toEqual([{ session: addresses[0]!.id, pending: 1 }])
  // The waiting session and the two quiet sessions observed last: never every session ever observed.
  expect((yield* Ref.get(heads)).toSorted()).toEqual([addresses[0]!.id, addresses[4]!.id, addresses[5]!.id].toSorted())
})).pipe(Effect.timeout("3 seconds"))))

test("a turn's own writes signal no waiting subscriber; its begin and its end do", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const log = yield* Layer.build(SessionLogMemoryLive).pipe(Effect.map((context) => Context.get(context, SessionLog)))
  const context = yield* Layer.build(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen))))
  const sessions = Context.get(context, Sessions)
  yield* sessions.create(address)
  const signals = yield* Ref.make(0)
  yield* sessions.waiting.pipe(Stream.runForEach(() => Ref.update(signals, (count) => count + 1)), Effect.forkScoped)
  const settled = (count: number) => Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { concurrency: 1, discard: true }).pipe(Effect.andThen(Ref.get(signals)), Effect.map((now) => now === count))
  expect(yield* settled(1)).toBe(true)
  const writer = yield* sessions.begin(address, { _tag: "User", runId: RunId.make("quiet-writes"), key: "quiet", command: {}, userMessage: new UserMessage({ text: "write a lot" }) })
  expect(yield* settled(2)).toBe(true)
  yield* Effect.forEach(Array.from({ length: 5 }, (_, n) => n), (n) => writer.append([{ kind: "host.note", data: { n } }]).pipe(Effect.andThen(writer.flush), Effect.andThen(Effect.yieldNow)), { concurrency: 1, discard: true })
  expect(yield* settled(2)).toBe(true)
  yield* writer.end({ reason: "completed", failure: Option.none() })
  expect(yield* settled(3)).toBe(true)
})).pipe(Effect.timeout("3 seconds"))))
