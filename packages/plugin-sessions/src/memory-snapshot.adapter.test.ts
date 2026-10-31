import { expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref } from "effect"
import { TestClock } from "effect/testing"
import { ConversationId, EntryId, frameworkDraft, InboxItemId, RunId, RunOrdinal, SessionLog, SessionLogError, SessionLogMemoryLive, Sessions, TurnAdmissionOpen, UserMessage, userRoleMessageOf } from "@xandreed/core"
import type { JsonObject, LogEntry, QueuedInput, SessionAddress, SessionCommit, SessionLogEvent, TurnWriter } from "@xandreed/core"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"
import { stateOf } from "./sessions-state.entity.functions.js"

type Log = Context.Service.Shape<typeof SessionLog>
type Service = Context.Service.Shape<typeof Sessions>
const config = { ...sessionsDefaults, ownership: { mode: "lease" as const, ttlMs: 60_000, renew: "none" as const } }
const instance = (log: Log) => Layer.build(SessionsLive(config).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)))).pipe(Effect.map((context) => Context.get(context, Sessions)))
const address: SessionAddress = { owner: "memory-snapshot-test", id: ConversationId.make("00000000-0000-4000-8000-000000009301") }
const other = ConversationId.make("00000000-0000-4000-8000-000000009302")
const completed = { reason: "completed" as const, failure: Option.none() }
const begin = (sessions: Service, target = address, key = "first") => sessions.begin(target, { _tag: "User", key, runId: RunId.make(`snapshot-${key}`), userMessage: new UserMessage({ text: key }), command: {} })
const load = (writer: TurnWriter) => writer.memorySnapshot ?? Effect.succeed(Option.none<SessionLogEvent>())
const payload = (writer: TurnWriter): JsonObject => ({ version: 1, strategy: { id: "summary", version: "2" }, anchor: { session: writer.started.session, seq: writer.started.seq }, through: { session: writer.started.session, seq: writer.started.seq }, entries: [] })
const publish = (writer: TurnWriter) => writer.append([frameworkDraft("memory.snapshot", payload(writer))]).pipe(Effect.andThen(writer.flush))
const withLog = <A, E>(use: (log: Log) => Effect.Effect<A, E, import("effect").Scope.Scope>) => Effect.runPromise(Effect.scoped(Effect.service(SessionLog).pipe(Effect.flatMap(use), Effect.provide(SessionLogMemoryLive))).pipe(Effect.timeout("10 seconds")))
const pointer = (log: Log, target = address) => log.head(target.id).pipe(Effect.map((head) => head.state.sessions))
const queued: QueuedInput = { id: InboxItemId.make("snapshot-steer"), source: {}, delivery: "steer", userMessage: new UserMessage({ text: "steer" }) }

test("a snapshot and its exact publication pointer commit together even when ordinary state is unchanged", () => withLog((base) => Effect.gen(function* () {
  const commits = yield* Ref.make<ReadonlyArray<SessionCommit>>([])
  const log = SessionLog.of({ ...base, commit: (id, commit) => Ref.update(commits, (all) => [...all, commit]).pipe(Effect.andThen(base.commit(id, commit))) })
  const sessions = yield* instance(log)
  yield* sessions.create(address)
  const first = yield* begin(sessions)
  yield* first.append([{ kind: "snapshot.prefix", data: {} }, frameworkDraft("memory.snapshot", payload(first)), { kind: "snapshot.suffix", data: {} }])
  yield* first.flush
  const rows = yield* sessions.read(address, { kinds: ["memory.snapshot"] })
  const saved = rows[0]!
  expect(yield* pointer(base)).toMatchObject({ memorySnapshot: { session: address.id, seq: saved.seq } })
  const commit = (yield* Ref.get(commits)).find((commit) => commit.events.some((event) => event.kind === "memory.snapshot"))!
  expect(Option.isSome(commit.state)).toBe(true)
  expect(saved.seq).toBe(first.started.seq + 2)
  yield* first.end(completed)
  const reopened = yield* begin(sessions, address, "reopened")
  expect(yield* load(reopened)).toEqual(Option.some(saved))
})))

test("a conflicting append recomputes the pointer from the final batch offset after rebasing", () => withLog((base) => Effect.gen(function* () {
  const conflict = yield* Ref.make(true)
  const attempts = yield* Ref.make(0)
  const log = SessionLog.of({ ...base, commit: (id, commit) => Effect.gen(function* () {
    if (commit.events.some((event) => event.kind === "memory.snapshot")) {
      yield* Ref.update(attempts, (n) => n + 1)
      if (yield* Ref.getAndSet(conflict, false)) {
        yield* base.commit(id, { expect: commit.expect, notAfter: Option.none(), state: Option.none(), events: [{ turn: Option.some(1), kind: "snapshot.foreign", data: {} }] })
      }
    }
    return yield* base.commit(id, commit)
  }) })
  const sessions = yield* instance(log)
  yield* sessions.create(address)
  const writer = yield* begin(sessions)
  yield* writer.append([{ kind: "snapshot.prefix", data: {} }, frameworkDraft("memory.snapshot", payload(writer))])
  yield* writer.flush
  const saved = (yield* sessions.read(address, { kinds: ["memory.snapshot"] }))[0]!
  expect(yield* Ref.get(attempts)).toBe(2)
  expect(saved.seq).toBe(writer.started.seq + 3)
  expect(yield* pointer(base)).toMatchObject({ memorySnapshot: { session: address.id, seq: saved.seq } })
})))

test("lease, inbox, take, end, cancellation, takeover and format transitions preserve the pointer", () => withLog((base) => Effect.gen(function* () {
  const sessions = yield* instance(base)
  yield* sessions.create(address)
  const first = yield* begin(sessions)
  yield* publish(first)
  const saved = (yield* sessions.read(address, { kinds: ["memory.snapshot"] }))[0]!
  const retained = () => pointer(base).pipe(Effect.tap((state) => Effect.sync(() => expect(state).toMatchObject({ memorySnapshot: { session: address.id, seq: saved.seq } }))))
  yield* first.end(completed)
  yield* retained()
  yield* sessions.enqueue(address, queued)
  yield* sessions.deliver(address, { id: InboxItemId.make("snapshot-notice"), source: {}, content: "notice" })
  yield* retained()
  const next = yield* begin(sessions, address, "next")
  const entry: LogEntry = { id: EntryId.make(`${next.admitted.runId}:1`), runId: next.admitted.runId, turn: next.admitted.turn, step: 0, at: 0, body: { _tag: "Message", inbox: queued.id, run: RunOrdinal.make(0), message: userRoleMessageOf(queued.userMessage) } }
  expect(yield* next.take([entry])).toBe(true)
  yield* retained()
  yield* sessions.cancel(address, next.admitted.turn)
  yield* retained()
  const current = yield* base.head(address.id)
  const state = yield* stateOf(current)
  yield* base.commit(address.id, { expect: current.revision, notAfter: Option.none(), events: [], state: Option.some({ sessions: { ...current.state.sessions as JsonObject, format: 1 } }) })
  expect(state.turns).toBe(2)
  const held = yield* begin(sessions, address, "held")
  yield* retained()
  const fresh = yield* instance(base)
  const takeover = yield* fresh.begin(address, { _tag: "User", key: "takeover", runId: RunId.make("snapshot-takeover"), userMessage: new UserMessage({ text: "continue" }), command: {}, takeOver: true })
  yield* retained()
  expect(yield* load(takeover)).toEqual(Option.some(saved))
  yield* takeover.end(completed)
  yield* retained()
  expect(held.admitted.turn).toBe(3)
})))

test("a selected ancestor uses exact bounded lookup and a latest post-fork pointer causes no future hydration", () => withLog((base) => Effect.gen(function* () {
  const reads = yield* Ref.make<ReadonlyArray<{ readonly session: string; readonly after: number; readonly through?: number }>>([])
  const missingFuture = yield* Ref.make(0)
  const log = SessionLog.of({ ...base, read: (id, query) => Effect.gen(function* () {
    if (query.kinds.includes("memory.snapshot")) yield* Ref.update(reads, (all) => [...all, { session: id, after: query.after, ...(query.through === undefined ? {} : { through: query.through }) }])
    if ((yield* Ref.get(missingFuture)) > 0 && id === address.id && query.kinds.includes("memory.snapshot") && (query.through === undefined || query.through >= (yield* Ref.get(missingFuture)))) {
      return yield* Effect.fail(new SessionLogError({ code: "store.decode", message: "the future snapshot's media is missing" }))
    }
    return yield* base.read(id, query)
  }) })
  const sessions = yield* instance(log)
  yield* sessions.create(address)
  const first = yield* begin(sessions)
  yield* publish(first)
  yield* first.end(completed)
  const saved = (yield* sessions.read(address, { kinds: ["memory.snapshot"] }))[0]!
  const child = yield* sessions.fork(address, { origin: "test", inherit: true })
  const childAddress = { owner: address.owner, id: child.header.id }
  const visible = yield* begin(sessions, childAddress, "visible-child")
  yield* Ref.set(reads, [])
  expect(yield* load(visible)).toEqual(Option.some(saved))
  expect(yield* Ref.get(reads)).toEqual([{ session: address.id, after: saved.seq - 1, through: saved.seq }])
  yield* visible.end(completed)
  const future = yield* begin(sessions, address, "future-parent")
  yield* publish(future)
  const latest = (yield* sessions.read(address, { kinds: ["memory.snapshot"] })).at(-1)!
  yield* future.end(completed)
  yield* Ref.set(missingFuture, latest.seq)
  const reopened = yield* begin(sessions, childAddress, "cut-child")
  yield* Ref.set(reads, [])
  expect(yield* load(reopened)).toEqual(Option.none())
  expect(yield* Ref.get(reads)).toEqual([])
})))

test.each(["missing", "version", "identity", "frontier"] as const)("a selected %s snapshot fails honestly instead of returning partial memory", (mode) => withLog((base) => Effect.gen(function* () {
  const tamper = yield* Ref.make(false)
  const log = SessionLog.of({ ...base, read: (id, query) => base.read(id, query).pipe(Effect.flatMap((events) => Ref.get(tamper).pipe(Effect.map((armed) => !armed || !query.kinds.includes("memory.snapshot") ? events
    : mode === "missing" ? [] : events.map((event) => mode === "version" ? { ...event, data: { ...event.data, version: 99 } }
      : mode === "frontier" ? { ...event, data: { ...event.data, through: { session: id, seq: event.seq } } } : { ...event, session: other }))))) })
  const sessions = yield* instance(log)
  yield* sessions.create(address)
  const first = yield* begin(sessions)
  yield* publish(first)
  yield* first.end(completed)
  const next = yield* begin(sessions, address, "tampered")
  yield* Ref.set(tamper, true)
  const failure = yield* Effect.flip(load(next))
  expect(failure).toMatchObject({ _tag: "SessionLogError", code: "session.decode" })
  expect(failure.message).toBe("The stored memory snapshot is invalid.")
})))

test("a cross-session own pointer fails before lookup, while an ineligible future pointer returns None", () => withLog((base) => Effect.gen(function* () {
  const reads = yield* Ref.make(0)
  const log = SessionLog.of({ ...base, read: (id, query) => Ref.update(reads, (count) => count + (query.kinds.includes("memory.snapshot") ? 1 : 0)).pipe(Effect.andThen(base.read(id, query))) })
  const sessions = yield* instance(log)
  yield* sessions.create(address)
  const first = yield* begin(sessions)
  yield* first.end(completed)
  const head = yield* base.head(address.id)
  yield* base.commit(address.id, { expect: head.revision, notAfter: Option.none(), events: [], state: Option.some({ sessions: { ...head.state.sessions as JsonObject, memorySnapshot: { session: other, seq: 1 } } }) })
  const invalid = yield* begin(sessions, address, "invalid-cursor")
  yield* Ref.set(reads, 0)
  expect(yield* Effect.flip(load(invalid))).toMatchObject({ _tag: "SessionLogError", code: "session.decode" })
  expect(yield* Ref.get(reads)).toBe(0)
  yield* invalid.end(completed)
  const current = yield* base.head(address.id)
  yield* base.commit(address.id, { expect: current.revision, notAfter: Option.none(), events: [], state: Option.some({ sessions: { ...current.state.sessions as JsonObject, memorySnapshot: { session: address.id, seq: current.seq + 10 } } }) })
  const future = yield* begin(sessions, address, "future-cursor")
  expect(yield* load(future)).toEqual(Option.none())
  expect(yield* Ref.get(reads)).toBe(0)
})))

test("a lost snapshot ACK stays the original failure while reopen observes its atomically durable pointer", () => withLog((base) => Effect.gen(function* () {
  const lost = new SessionLogError({ code: "ack.lost", message: "the snapshot committed before its acknowledgement failed" })
  const log = SessionLog.of({ ...base, commit: (id, commit) => base.commit(id, commit).pipe(Effect.flatMap((answer) => commit.events.some((event) => event.kind === "memory.snapshot") ? Effect.fail(lost) : Effect.succeed(answer))) })
  const sessions = yield* instance(log)
  yield* sessions.create(address)
  const first = yield* begin(sessions)
  expect(yield* Effect.flip(publish(first))).toBe(lost)
  expect(yield* Effect.flip(first.flush)).toBe(lost)
  const saved = (yield* sessions.read(address, { kinds: ["memory.snapshot"] }))[0]!
  expect(yield* pointer(base)).toMatchObject({ memorySnapshot: { session: address.id, seq: saved.seq } })
  const fresh = yield* instance(base)
  const next = yield* fresh.begin(address, { _tag: "User", key: "lost-ack", runId: RunId.make("snapshot-lost-ack"), userMessage: new UserMessage({ text: "continue" }), command: {}, takeOver: true })
  expect(yield* load(next)).toEqual(Option.some(saved))
  expect(yield* sessions.read(address, { kinds: ["memory.snapshot"] })).toHaveLength(1)
})))

test("nested lineage selects the closest own-session pointer even when parent sequence numbers overlap", () => withLog((base) => Effect.gen(function* () {
  const sessions = yield* instance(base)
  yield* sessions.create(address)
  const root = yield* begin(sessions)
  yield* publish(root)
  yield* root.end(completed)
  const fork = yield* sessions.fork(address, { origin: "test", inherit: true })
  const child = { owner: address.owner, id: fork.header.id }
  const next = yield* begin(sessions, child, "child-own-snapshot")
  const data: JsonObject = { ...payload(next), anchor: { session: address.id, seq: root.started.seq } }
  yield* next.append([frameworkDraft("memory.snapshot", data)])
  yield* next.end(completed)
  const childSaved = (yield* sessions.read(child, { kinds: ["memory.snapshot"] }))[0]!
  expect(childSaved.seq).toBe(root.started.seq + 1)
  const grandchild = yield* sessions.fork(child, { origin: "test", inherit: true })
  const nested = yield* begin(sessions, { owner: address.owner, id: grandchild.header.id }, "grandchild")
  expect(yield* load(nested)).toEqual(Option.some(childSaved))
})))

test.each(["version", "future", "backward"] as const)("an invalid %s publication changes neither journal nor pointer", (mode) => withLog((base) => Effect.gen(function* () {
  const sessions = yield* instance(base)
  yield* sessions.create(address)
  const writer = yield* begin(sessions)
  const before = yield* base.head(address.id)
  const data: JsonObject = mode === "version" ? { ...payload(writer), version: 2 }
    : mode === "future" ? { ...payload(writer), through: { session: address.id, seq: writer.started.seq + 1 } }
      : { ...payload(writer), anchor: { session: other, seq: 1 } }
  yield* writer.append([frameworkDraft("memory.snapshot", data)])
  const failure = yield* Effect.flip(writer.flush)
  expect(failure).toMatchObject({ _tag: "SessionLogError", code: "session.decode" })
  expect(yield* Effect.flip(writer.flush)).toBe(failure)
  expect((yield* base.head(address.id)).revision).toBe(before.revision)
  expect(yield* sessions.read(address, { kinds: ["memory.snapshot"] })).toEqual([])
})))

test("interrupting an ACK waiter cannot separate a durable snapshot row from its pointer", () => withLog((base) => Effect.gen(function* () {
  const stored = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const log = SessionLog.of({ ...base, commit: (id, commit) => base.commit(id, commit).pipe(Effect.tap(() => commit.events.some((event) => event.kind === "memory.snapshot")
    ? Deferred.succeed(stored, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)) })
  const sessions = yield* instance(log)
  yield* sessions.create(address)
  const writer = yield* begin(sessions)
  yield* writer.append([frameworkDraft("memory.snapshot", payload(writer))])
  const waiting = yield* Effect.forkChild(writer.flush)
  yield* Deferred.await(stored)
  const saved = (yield* base.read(address.id, { after: 0, limit: Option.none(), kinds: ["memory.snapshot"] }))[0]!
  expect(yield* pointer(base)).toMatchObject({ memorySnapshot: { session: address.id, seq: saved.seq } })
  yield* Fiber.interrupt(waiting)
  yield* Deferred.succeed(release, undefined)
  yield* writer.flush
  yield* writer.end(completed)
  const reopened = yield* begin(sessions, address, "interrupted-waiter")
  expect(yield* load(reopened)).toEqual(Option.some(saved))
})))

test("keep-alive and lease reaping preserve an already published pointer", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const base = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const build = (renew: "none" | { readonly everyMs: number }) => Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 1000, renew } }).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, base), TurnAdmissionOpen)))).pipe(Effect.map((context) => Context.get(context, Sessions)))
  const sessions = yield* build({ everyMs: 100 })
  yield* sessions.create(address)
  const first = yield* begin(sessions)
  yield* publish(first)
  const saved = (yield* sessions.read(address, { kinds: ["memory.snapshot"] }))[0]!
  const revision = (yield* base.head(address.id)).revision
  yield* TestClock.adjust(100)
  yield* first.flush
  expect((yield* base.head(address.id)).revision).toBeGreaterThan(revision)
  expect(yield* pointer(base)).toMatchObject({ memorySnapshot: { session: address.id, seq: saved.seq } })
  yield* first.end(completed)
  const fixed = yield* build("none")
  yield* begin(fixed, address, "expires")
  yield* TestClock.adjust(1001)
  const reaped = yield* begin(fixed, address, "reaped")
  expect(yield* load(reaped)).toEqual(Option.some(saved))
  expect(yield* pointer(base)).toMatchObject({ memorySnapshot: { session: address.id, seq: saved.seq } })
})).pipe(Effect.provide(TestClock.layer()))))

test("a malformed own head retains session.state while a selected malformed ancestor pointer is session.decode", () => withLog((base) => Effect.gen(function* () {
  const sessions = yield* instance(base)
  yield* sessions.create(address)
  const first = yield* begin(sessions)
  yield* first.end(completed)
  const child = yield* sessions.fork(address, { origin: "test", inherit: true })
  const head = yield* base.head(address.id)
  yield* base.commit(address.id, { expect: head.revision, notAfter: Option.none(), events: [], state: Option.some({ sessions: { ...head.state.sessions as JsonObject, memorySnapshot: { session: address.id, seq: 0 } } }) })
  expect(yield* Effect.flip(begin(sessions, address, "malformed-own"))).toMatchObject({ _tag: "SessionLogError", code: "session.state" })
  const nested = yield* begin(sessions, { owner: address.owner, id: child.header.id }, "malformed-ancestor")
  expect(yield* Effect.flip(load(nested))).toMatchObject({ _tag: "SessionLogError", code: "session.decode" })
})))
