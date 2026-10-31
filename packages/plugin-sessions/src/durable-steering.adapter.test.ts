import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import { ConversationId, entriesOfEvents, EntryId, InboxItemId, readStored, RunId, RunOrdinal, SessionLog, SessionLogError, SessionLogMemoryLive, Sessions, STORED_FORMAT, TurnAdmissionOpen, UserMessage, userRoleMessageOf } from "@xandreed/core"
import type { LogEntry, QueuedInput, SessionAddress, TurnWriter } from "@xandreed/core"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"
import { stateJson, stateOf } from "./sessions-state.entity.functions.js"

type Log = Context.Service.Shape<typeof SessionLog>
const config = { ...sessionsDefaults, ownership: { mode: "lease" as const, ttlMs: 60_000, renew: "on-commit" as const }, inbox: { maxPending: 20, attempts: 1 } }
const instance = (log: Log) => Layer.build(SessionsLive(config).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)))).pipe(Effect.map((context) => Context.get(context, Sessions)))
const session: SessionAddress = { id: ConversationId.make("00000000-0000-4000-8000-000000007121"), owner: "durable-steering-test" }
const complete = { reason: "completed" as const, failure: Option.none() }
const interrupted = { reason: "interrupted" as const, failure: Option.none() }
const input = (id: string, delivery: QueuedInput["delivery"] = "steer"): QueuedInput => ({ id: InboxItemId.make(id), delivery, source: {}, userMessage: new UserMessage({ text: `exact ${id}` }) })
const entry = (writer: TurnWriter, queued: QueuedInput, index: number): LogEntry => ({
  id: EntryId.make(`${writer.admitted.runId}:${index}`), runId: writer.admitted.runId, turn: writer.admitted.turn,
  step: 0, at: 0, body: { _tag: "Message", inbox: queued.id, run: RunOrdinal.make(0), message: userRoleMessageOf(queued.userMessage) },
})
const begin = (sessions: Context.Service.Shape<typeof Sessions>) => sessions.begin(session, { _tag: "User", key: "writer-key", runId: RunId.make("writer-run"), userMessage: new UserMessage({ text: "initial request" }), command: {} })

test("probes and rejected takes do not commit or count notice attempts; accepted takes do", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const log = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const sessions = yield* instance(log)
  yield* sessions.create(session)
  yield* sessions.deliver(session, { id: InboxItemId.make("notice"), source: {}, content: "notice work" })
  const next = input("next", "next")
  yield* sessions.enqueue(session, next)
  const writer = yield* sessions.begin(session, { _tag: "Inbox", runId: RunId.make("notice-run") })
  const before = yield* log.head(session.id)
  expect(yield* writer.steers).toEqual([])
  expect(yield* writer.take([])).toBe(false)
  expect(yield* writer.take([entry(writer, next, 1)])).toBe(false)
  expect((yield* log.head(session.id)).revision).toBe(before.revision)
  yield* writer.end(interrupted)
  expect((yield* sessions.get(session)).pending).toBe(2)
  expect(yield* sessions.read(session, { kinds: ["inbox.dropped"] })).toEqual([])
  const taken = input("taken")
  yield* sessions.enqueue(session, taken)
  const retry = yield* sessions.begin(session, { _tag: "Inbox", runId: RunId.make("notice-retry") })
  expect(yield* retry.take([entry(retry, taken, 1)])).toBe(true)
  yield* retry.end(interrupted)
  expect((yield* sessions.get(session)).pending).toBe(1)
  expect((yield* readStored("inbox.dropped", yield* sessions.read(session))).map(({ data }) => String(data.id))).toEqual(["notice"])
})).pipe(Effect.timeout("3 seconds"))))

test("a conflicting enqueue is rebased without losing a newer unselected steer", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const base = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const paused = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const armed = yield* Ref.make(true)
  const delayed = SessionLog.of({ ...base, commit: (id, request) => Effect.gen(function* () {
    if (request.events.some((event) => event.kind === "inbox.taken") && (yield* Ref.getAndSet(armed, false))) {
      yield* Deferred.succeed(paused, undefined)
      yield* Deferred.await(release)
    }
    return yield* base.commit(id, request)
  }) })
  const [holder, sender] = [yield* instance(delayed), yield* instance(base)]
  yield* holder.create(session)
  const writer = yield* begin(holder)
  const one = input("one")
  const two = input("two")
  yield* sender.enqueue(session, one)
  yield* sender.enqueue(session, two)
  const taking = yield* Effect.forkChild(writer.take([entry(writer, one, 1), entry(writer, two, 2)]))
  yield* Effect.gen(function* () {
    yield* Deferred.await(paused)
    yield* sender.enqueue(session, input("newer"))
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(taking)).toBe(true)
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  expect((yield* writer.steers).map((queued) => String(queued.id))).toEqual(["newer"])
  const events = yield* holder.read(session)
  expect((yield* readStored("inbox.taken", events)).map(({ data }) => String(data.id))).toEqual(["one", "two"])
  expect((yield* entriesOfEvents(events)).filter((item) => item.body._tag === "Message").map((item) => String(item.id))).toEqual(["writer-run:1", "writer-run:2"])
  yield* writer.end(complete)
})).pipe(Effect.timeout("3 seconds"))))

test("a store that loses the take ACK leaves exactly one durable batch and rejects reused memory ids", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const base = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const armed = yield* Ref.make(true)
  const uncertain = SessionLog.of({ ...base, commit: (id, request) => base.commit(id, request).pipe(Effect.flatMap((committed) =>
    request.events.some((event) => event.kind === "inbox.taken") ? Ref.getAndSet(armed, false).pipe(Effect.flatMap((lose) => lose
      ? Effect.fail(new SessionLogError({ code: "ack.lost", message: "the take was stored but its acknowledgement was lost" }))
      : Effect.succeed(committed))) : Effect.succeed(committed))) })
  const sessions = yield* instance(uncertain)
  yield* sessions.create(session)
  const writer = yield* begin(sessions)
  const first = input("first")
  yield* sessions.enqueue(session, first)
  const prepared = [entry(writer, first, 1)]
  expect(yield* Effect.flip(writer.take(prepared))).toMatchObject({ _tag: "SessionLogError", code: "ack.lost" })
  expect(yield* writer.take(prepared)).toBe(false)
  expect((yield* sessions.get(session)).pending).toBe(0)
  const second = input("second")
  yield* sessions.enqueue(session, second)
  expect(yield* Effect.flip(writer.take([entry(writer, second, 1)]))).toMatchObject({ _tag: "HarnessError", code: "memory.log" })
  expect(yield* Effect.flip(writer.take([{ ...entry(writer, second, 2), id: EntryId.make("another-run:2") }]))).toMatchObject({ _tag: "HarnessError", code: "memory.log" })
  expect(yield* writer.take([entry(writer, second, 2)])).toBe(true)
  const events = yield* sessions.read(session)
  expect((yield* readStored("inbox.taken", events)).map(({ data }) => String(data.entry))).toEqual(["writer-run:1", "writer-run:2"])
  yield* writer.end(complete)
})).pipe(Effect.timeout("3 seconds"))))

test("a cancellation during the take CAS fences the old writer before it stores messages", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const base = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const paused = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const delayed = SessionLog.of({ ...base, commit: (id, request) => request.events.some((event) => event.kind === "inbox.taken")
    ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(base.commit(id, request)))
    : base.commit(id, request) })
  const [holder, closer] = [yield* instance(delayed), yield* instance(base)]
  yield* holder.create(session)
  const writer = yield* begin(holder)
  const pending = input("pending")
  yield* closer.enqueue(session, pending)
  const taking = yield* Effect.forkChild(Effect.flip(writer.take([entry(writer, pending, 1)])))
  yield* Effect.gen(function* () {
    yield* Deferred.await(paused)
    yield* closer.cancel(session, writer.admitted.turn)
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(taking)).toMatchObject({ _tag: "TurnClosed", reason: "cancelled" })
  }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)))
  expect(yield* holder.read(session, { kinds: ["inbox.taken", "memory.message"] })).toEqual([])
  expect((yield* closer.get(session)).pending).toBe(1)
})).pipe(Effect.timeout("3 seconds"))))

test("a newer stored format fences writer probes and takes without downgrading its state", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const log = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const sessions = yield* instance(log)
  yield* sessions.create(session)
  const writer = yield* begin(sessions)
  const pending = input("pending")
  yield* sessions.enqueue(session, pending)
  const head = yield* log.head(session.id)
  const state = yield* stateOf(head)
  const newer = yield* stateJson({ ...state, format: STORED_FORMAT + 1 })
  yield* log.commit(session.id, { expect: head.revision, notAfter: Option.none(), events: [], state: Option.some(newer) })
  expect(yield* Effect.flip(writer.steers)).toMatchObject({ _tag: "SessionLogError", code: "session.version" })
  expect(yield* Effect.flip(writer.take([entry(writer, pending, 1)]))).toMatchObject({ _tag: "SessionLogError", code: "session.version" })
  expect((yield* stateOf(yield* log.head(session.id))).format).toBe(STORED_FORMAT + 1)
  expect(yield* sessions.read(session, { kinds: ["inbox.taken", "memory.message"] })).toEqual([])
})).pipe(Effect.timeout("3 seconds"))))
