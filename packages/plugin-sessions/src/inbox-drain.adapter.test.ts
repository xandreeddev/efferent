import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Fiber, Layer, Option, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
import {
  ConversationId, DrainActivity, EntryId, InboxItemId, InboxRunner, RunId, Sessions, SessionMissing,
  HarnessError, SessionLog, SessionLogMemoryLive, TurnAdmissionOpen, TurnDuplicate, TurnShutdown, turnStartedDraft, UserMessage,
} from "@xandreed/core"
import type { BeginTurn, OpenTurn, QueuedInput, SessionAddress, SessionLogEvent, SessionView, TurnWriter } from "@xandreed/core"
import { InboxDrainLive } from "./inbox-drain.adapter.js"
import type { InboxDrainOptions } from "./inbox-drain.entity.js"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"

const real = Effect.gen(function* () {
  const log = Context.get(yield* Layer.build(SessionLogMemoryLive), SessionLog)
  const instance = () => Layer.build(SessionsLive({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 600_000, renew: "on-commit" } }).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen))))
  const context = yield* instance()
  return { context, sessions: Context.get(context, Sessions), other: () => instance().pipe(Effect.map(Context.get(Sessions))) }
})
type Real = Effect.Success<typeof real>
const start = (subject: Real, runner: Context.Service.Shape<typeof InboxRunner>, options: InboxDrainOptions, sessions = subject.sessions) =>
  Layer.build(InboxDrainLive(options)).pipe(Effect.provide(Context.add(Context.add(subject.context, Sessions, sessions), InboxRunner, runner)), Effect.map(Context.get(DrainActivity)))
const create = (sessions: Context.Service.Shape<typeof Sessions>, n: number, owner = "owner") => {
  const address: SessionAddress = { owner, id: ConversationId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`) }
  return sessions.create(address).pipe(Effect.as(address))
}
const queued = (id: string): QueuedInput => ({ id: InboxItemId.make(id), delivery: "next", source: {}, userMessage: new UserMessage({ text: id }) })
const eventually = <A, E>(value: Effect.Effect<A, E>, holds: (a: A) => boolean, tries = 200): Effect.Effect<A, E> => value.pipe(Effect.flatMap((now) =>
  holds(now) || tries <= 0 ? Effect.succeed(now) : Effect.yieldNow.pipe(Effect.andThen(Effect.suspend(() => eventually(value, holds, tries - 1))))))

describe("InboxDrainLive", () => {
  test("the initial subscribed wake drains a fake session through its exact queued writer, then becomes idle", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const address = { owner: "fake-owner", id: ConversationId.make("00000000-0000-4000-8000-000000005601") }
    const input: QueuedInput = { id: InboxItemId.make("q"), delivery: "next", source: {}, userMessage: new UserMessage({ text: "queued work" }) }
    const pending = yield* Ref.make(true)
    const open = yield* Ref.make(Option.none<OpenTurn>())
    const ended = yield* Deferred.make<void>()
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const stored = yield* Ref.make<ReadonlyArray<SessionLogEvent>>([{
      session: address.id, seq: 1, turn: Option.none(), at: 0, kind: "inbox.queued",
      data: { id: input.id, source: {}, content: "", input: { userMessage: { text: input.userMessage.text }, delivery: "next" } },
    }])
    const view: Effect.Effect<SessionView> = Effect.gen(function* () {
      const events = yield* Ref.get(stored)
      return { header: { ...address, origin: "user", createdAt: 0, meta: {}, parent: Option.none() }, seq: events.length, updatedAt: 0,
        turns: events.some((event) => event.kind === "turn.started") ? 1 : 0, title: Option.none(), open: yield* Ref.get(open), pending: (yield* Ref.get(pending)) ? 1 : 0 }
    })
    const fake = Sessions.of({
      create: () => Effect.die("unused"), fork: () => Effect.die("unused"), get: (asked) => asked.owner === address.owner ? view : Effect.fail(new SessionMissing({ session: asked.id })),
      list: (query) => query.owner === address.owner && query.parent === undefined ? view.pipe(Effect.map((session) => ({ sessions: [session], next: Option.none() }))) : Effect.succeed({ sessions: [], next: Option.none() }),
      read: (_address, query) => Ref.get(stored).pipe(Effect.map((events) => events.filter((event) => query?.kinds === undefined || query.kinds.length === 0 || query.kinds.includes(event.kind)))),
      waiting: Stream.succeed(undefined), changes: () => Stream.never,
      remove: () => Effect.die("unused"), lookup: () => Effect.die("unused"), transact: () => Effect.die("unused"), cancel: () => Effect.die("unused"), enqueue: () => Effect.die("unused"), deliver: () => Effect.die("unused"), drain: () => Effect.die("unused"),
      begin: (_address, asked) => Effect.gen(function* () {
        if (asked._tag !== "Queued") return yield* Effect.die("expected queued admission")
        const draft = yield* turnStartedDraft(1, { runId: asked.runId, key: "input:q", origin: "user", userMessage: input.userMessage, command: {}, claimed: [], input: input.id, entry: EntryId.make(`${asked.runId}:0`), at: 0 }).pipe(Effect.orDie)
        const started: SessionLogEvent = { session: address.id, seq: 2, turn: Option.some(1), kind: draft.kind, at: 0, data: draft.data }
        yield* Ref.update(stored, (events) => [...events, started])
        yield* Ref.set(open, Option.some({ turn: 1, runId: asked.runId, key: "input:q", origin: "user", holder: "fake", expiresAt: Option.none() }))
        const writer: TurnWriter = {
          admitted: { session: address, turn: 1, runId: asked.runId, key: "input:q", origin: "user", userMessage: input.userMessage, command: {}, claimed: [], input, meta: {} }, started,
          history: () => Effect.succeed([]), snapshot: () => Ref.get(stored), steers: Effect.succeed([]), take: () => Effect.succeed(false),
          append: () => Effect.die("unused"), write: () => Effect.die("unused"), transact: () => Effect.die("unused"), flush: Effect.void, closing: () => Effect.die("unused"), closed: Effect.never,
          end: (ending) => Ref.update(stored, (events) => [...events, { session: address.id, seq: events.length + 1, turn: Option.some(1), kind: "turn.ended", at: 0, data: { reason: ending.reason, failure: null } }]).pipe(
            Effect.andThen(Ref.set(pending, false)), Effect.andThen(Ref.set(open, Option.none())), Effect.andThen(Deferred.succeed(ended, undefined)), Effect.as({ pending: 0 }),
          ),
        }
        return writer
      }),
    })
    const runner = InboxRunner.of({ run: (writer) => Ref.update(seen, (values) => [...values, `${writer.admitted.origin}:${writer.admitted.input?.id}:${writer.admitted.userMessage.text}`]).pipe(Effect.as({ outcome: "completed", reply: Option.none() })) })
    const built = yield* Layer.build(InboxDrainLive({ owners: [address.owner], resume: { _tag: "Never" } })).pipe(Effect.provideService(Sessions, fake), Effect.provideService(InboxRunner, runner))
    const completed = yield* Deferred.await(ended).pipe(Effect.timeoutOption("150 millis"))
    expect(Option.isSome(completed)).toBe(true)
    yield* Context.get(built, DrainActivity).idle
    expect(yield* Ref.get(seen)).toEqual(["user:q:queued work"])
    expect(yield* Context.get(built, DrainActivity).running).toBe(0)
  })).pipe(Effect.timeout("3 seconds"))))
})

describe("InboxDrainLive over real Sessions", () => {
  test.each(["completed", "waiting"] as const)("afterEnd waits for the %s end ACK and a failed hook cannot retry consumed input", (reason) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, reason === "waiting" ? 5691 : 5690)
    yield* subject.sessions.enqueue(address, queued("once"))
    const committed = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const handed = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const hooks = yield* Ref.make(0)
    const sessions = Sessions.of({ ...subject.sessions, begin: (address, input) => subject.sessions.begin(address, input).pipe(Effect.map((writer) => ({ ...writer,
      end: (ending) => writer.end(ending).pipe(Effect.tap(() => Deferred.succeed(committed, undefined).pipe(Effect.andThen(Deferred.await(release))))),
    }))) })
    const activity = yield* start(subject, InboxRunner.of({
      run: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as({ outcome: reason, reply: Option.none() })),
      afterEnd: (writer, ending) => Effect.gen(function* () {
        expect(String(writer.admitted.input?.id)).toBe("once")
        expect(ending.reason).toBe(reason)
        expect((yield* subject.sessions.get(address).pipe(Effect.orDie)).pending).toBe(0)
        expect((yield* subject.sessions.read(address, { kinds: ["turn.ended"] }).pipe(Effect.orDie)).map((event) => event.data.reason)).toEqual([reason])
        yield* Ref.update(hooks, (n) => n + 1)
        yield* Deferred.succeed(handed, undefined)
        return yield* Effect.fail(new HarnessError({ code: "task.turn", message: "handoff failed after the end ACK" }))
      }),
    }), { owners: [address.owner], sweepIntervalMs: 10, resume: { _tag: "Never" } }, sessions)
    yield* Deferred.await(committed)
    expect((yield* subject.sessions.read(address, { kinds: ["turn.ended"] })).map((event) => event.data.reason)).toEqual([reason])
    expect(yield* Ref.get(hooks)).toBe(0)
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(handed)
    yield* activity.idle
    yield* TestClock.adjust("100 millis")
    yield* activity.idle
    expect(yield* Ref.get(calls)).toBe(1)
    expect(yield* Ref.get(hooks)).toBe(1)
    expect((yield* subject.sessions.get(address)).pending).toBe(0)
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))

  test("an end committed with a lost ACK skips afterEnd and a fresh drainer does not execute that input", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5692)
    yield* subject.sessions.enqueue(address, queued("lost-ack"))
    const committed = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const hooks = yield* Ref.make(0)
    const sessions = Sessions.of({ ...subject.sessions, begin: (address, input) => subject.sessions.begin(address, input).pipe(Effect.map((writer) => ({ ...writer,
      end: (ending) => writer.end(ending).pipe(Effect.andThen(Deferred.succeed(committed, undefined)), Effect.andThen(Effect.fail(new HarnessError({ code: "session.defect", message: "the end ACK was lost" })))),
    }))) })
    const activity = yield* start(subject, InboxRunner.of({
      run: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as({ outcome: "waiting", reply: Option.none() })),
      afterEnd: () => Ref.update(hooks, (n) => n + 1),
    }), { owners: [address.owner], sweepIntervalMs: 10, resume: { _tag: "Never" } }, sessions)
    yield* Deferred.await(committed)
    yield* activity.idle
    const foreign = yield* subject.other()
    const fresh = yield* start(subject, InboxRunner.of({ run: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as({ outcome: "completed", reply: Option.none() })) }),
      { owners: [address.owner], sweepIntervalMs: 10, resume: { _tag: "Never" } }, foreign)
    yield* TestClock.adjust("100 millis")
    yield* fresh.idle
    expect(yield* Ref.get(calls)).toBe(1)
    expect(yield* Ref.get(hooks)).toBe(0)
    expect((yield* foreign.get(address)).pending).toBe(0)
    expect((yield* foreign.read(address, { kinds: ["turn.ended"] })).map((event) => event.data.reason)).toEqual(["waiting"])
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))

  test("even the periodic timer waits until the global waiting subscription exists before the startup sweep", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5602)
    yield* subject.sessions.enqueue(address, queued("startup"))
    const subscribing = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const ran = yield* Deferred.make<void>()
    const lists = yield* Ref.make(0)
    const wrapped = Sessions.of({ ...subject.sessions,
      waiting: Stream.unwrap(Deferred.succeed(subscribing, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.as(subject.sessions.waiting))),
      list: (query) => Ref.update(lists, (n) => n + 1).pipe(Effect.andThen(subject.sessions.list(query))),
    })
    yield* start(subject, InboxRunner.of({ run: () => Deferred.succeed(ran, undefined).pipe(Effect.as({ outcome: "completed", reply: Option.none() })) }), { owners: [address.owner], sweepIntervalMs: 10, resume: { _tag: "Never" } }, wrapped)
    yield* Deferred.await(subscribing)
    yield* TestClock.adjust("50 millis")
    expect(yield* Ref.get(lists)).toBe(0)
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(ran)
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))

  test("commits for distinct sessions while startup is blocked coalesce into another complete sweep", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const first = yield* create(subject.sessions, 5603)
    const reading = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const armed = yield* Ref.make(true)
    const wrapped = Sessions.of({ ...subject.sessions, read: (address, query) => subject.sessions.read(address, query).pipe(Effect.tap(() => address.id === first.id
      ? Ref.getAndSet(armed, false).pipe(Effect.flatMap((once) => once ? Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(release))) : Effect.void)) : Effect.void)) })
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const done = yield* Deferred.make<void>()
    yield* start(subject, InboxRunner.of({ run: (writer) => Ref.updateAndGet(seen, (all) => [...all, String(writer.admitted.input?.id)]).pipe(Effect.flatMap((all) => all.length === 2 ? Deferred.succeed(done, undefined) : Effect.void), Effect.as({ outcome: "completed", reply: Option.none() })) }),
      { owners: [first.owner], concurrency: 1, sweepIntervalMs: 1_000_000, resume: { _tag: "Never" } }, wrapped)
    yield* Deferred.await(reading)
    const a = yield* create(subject.sessions, 5604)
    const b = yield* create(subject.sessions, 5605)
    yield* subject.sessions.enqueue(a, queued("a"))
    yield* subject.sessions.enqueue(b, queued("b"))
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(done)
    expect((yield* Ref.get(seen)).toSorted()).toEqual(["a", "b"])
  })).pipe(Effect.timeout("3 seconds"))))

  test("owner-scoped discovery follows every page and child level, including children of empty parents", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const { sessions } = subject
    const parent = yield* create(sessions, 5610)
    const top = yield* create(sessions, 5611)
    const child = { owner: parent.owner, id: ConversationId.make("00000000-0000-4000-8000-000000005612") }
    const grandchild = { owner: parent.owner, id: ConversationId.make("00000000-0000-4000-8000-000000005613") }
    yield* sessions.fork(parent, { id: child.id, origin: "task", inherit: false })
    yield* sessions.fork(child, { id: grandchild.id, origin: "task", inherit: false })
    yield* Effect.forEach([top, child, grandchild], (address, n) => sessions.enqueue(address, queued(`q-${n}`)), { concurrency: 1 })
    const foreign = yield* subject.other()
    const ignored = yield* create(foreign, 5614, "ignored-owner")
    yield* foreign.enqueue(ignored, queued("must-wait"))
    const listed = yield* Ref.make<ReadonlyArray<{ readonly parent: string; readonly after: boolean }>>([])
    const wrapped = Sessions.of({ ...sessions, list: (query) => Ref.update(listed, (all) => [...all, { parent: query.parent ?? "root", after: query.before !== undefined }]).pipe(Effect.andThen(sessions.list(query))) })
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const done = yield* Deferred.make<void>()
    const runner = InboxRunner.of({ run: (writer) => Ref.updateAndGet(seen, (all) => [...all, String(writer.admitted.session.id)]).pipe(
      Effect.flatMap((all) => all.length === 3 ? Deferred.succeed(done, undefined) : Effect.void), Effect.as({ outcome: "completed", reply: Option.none() }),
    ) })
    const activity = yield* start(subject, runner, { owners: [parent.owner], concurrency: 2, pageSize: 1, resume: { _tag: "Never" } }, wrapped)
    yield* Deferred.await(done)
    yield* activity.idle
    expect((yield* Ref.get(seen)).toSorted()).toEqual([String(top.id), String(child.id), String(grandchild.id)].toSorted())
    expect((yield* foreign.get(ignored)).pending).toBe(1)
    expect((yield* Ref.get(listed)).some((query) => query.after)).toBe(true)
    expect((yield* Ref.get(listed)).some((query) => query.parent === parent.id)).toBe(true)
    expect((yield* Ref.get(listed)).some((query) => query.parent === child.id)).toBe(true)
  })).pipe(Effect.timeout("3 seconds"))))

  test("fixed workers run different sessions concurrently and repeated wakes never overlap the same session", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const a = yield* create(subject.sessions, 5620)
    const b = yield* create(subject.sessions, 5621)
    yield* subject.sessions.enqueue(a, queued("a-first"))
    yield* subject.sessions.enqueue(b, queued("b-first"))
    const counts = yield* Ref.make<Readonly<Record<string, number>>>({})
    const peak = yield* Ref.make(0)
    const perSession = yield* Ref.make(0)
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const both = yield* Deferred.make<void>()
    const done = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const runner = InboxRunner.of({ run: (writer) => Effect.gen(function* () {
      const current = yield* Ref.updateAndGet(counts, (all) => ({ ...all, [writer.admitted.session.id]: (all[writer.admitted.session.id] ?? 0) + 1 }))
      const total = Object.values(current).reduce((sum, n) => sum + n, 0)
      yield* Ref.update(peak, (n) => Math.max(n, total))
      yield* Ref.update(perSession, (n) => Math.max(n, current[writer.admitted.session.id] ?? 0))
      if (total === 2) yield* Deferred.succeed(both, undefined)
      yield* Deferred.await(release)
      const all = yield* Ref.updateAndGet(seen, (values) => [...values, String(writer.admitted.input?.id)])
      if (all.length === 3) yield* Deferred.succeed(done, undefined)
      return { outcome: "completed" as const, reply: Option.none() }
    }).pipe(Effect.ensuring(Ref.update(counts, (all) => ({ ...all, [writer.admitted.session.id]: (all[writer.admitted.session.id] ?? 1) - 1 })))) })
    const activity = yield* start(subject, runner, { owners: [a.owner], concurrency: 2, resume: { _tag: "Never" }, sweepIntervalMs: 10 })
    yield* Deferred.await(both)
    expect(yield* activity.running).toBe(2)
    const idle = yield* Effect.forkChild(activity.idle)
    yield* subject.sessions.enqueue(a, queued("a-next"))
    yield* Effect.yieldNow
    expect(idle.pollUnsafe()).toBeUndefined()
    yield* Deferred.succeed(release, undefined)
    yield* Deferred.await(done)
    yield* activity.idle
    expect((yield* Ref.get(seen)).toSorted()).toEqual(["a-first", "a-next", "b-first"])
    expect(yield* Ref.get(peak)).toBe(2)
    expect(yield* Ref.get(perSession)).toBe(1)
    expect(yield* activity.running).toBe(0)
  })).pipe(Effect.timeout("3 seconds"))))

  test("periodic sweeps discover a foreign enqueue even with no local wake after startup", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5630)
    const foreign = yield* subject.other()
    const initialRead = yield* Deferred.make<void>()
    const wrapped = Sessions.of({ ...subject.sessions, waiting: Stream.succeed(undefined), read: (address, query) => subject.sessions.read(address, query).pipe(Effect.tap(() => Deferred.succeed(initialRead, undefined))) })
    const ran = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    yield* start(subject, InboxRunner.of({ run: () => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Deferred.succeed(ran, undefined)), Effect.as({ outcome: "completed", reply: Option.none() })) }), { owners: [address.owner], sweepIntervalMs: 50, resume: { _tag: "Never" } }, wrapped)
    yield* Deferred.await(initialRead)
    yield* foreign.enqueue(address, queued("foreign"))
    yield* TestClock.adjust("49 millis")
    expect(yield* Ref.get(calls)).toBe(0)
    yield* TestClock.adjust("1 millis")
    yield* Deferred.await(ran)
    expect(yield* Ref.get(calls)).toBe(1)
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))

  test("partial and failed input back off by payload identity despite own commits, then complete without a retry ceiling", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5640)
    yield* subject.sessions.enqueue(address, queued("same-payload"))
    const calls = yield* Ref.make(0)
    const runner = InboxRunner.of({ run: () => Ref.getAndUpdate(calls, (n) => n + 1).pipe(Effect.flatMap((index) => index === 1
      ? Effect.fail(new HarnessError({ code: "memory.log", message: "try again" }))
      : Effect.succeed({ outcome: index === 0 ? "partial" as const : "completed" as const, reply: Option.none() }))) })
    const activity = yield* start(subject, runner, { owners: [address.owner], concurrency: 1, sweepIntervalMs: 1000, resume: { _tag: "Never" }, backoff: { initialMs: 10, maxMs: 20 } })
    yield* eventually(subject.sessions.read(address, { kinds: ["turn.ended"] }), (events) => events.length === 1)
    yield* activity.idle
    yield* Effect.forEach([1, 2, 3], (n) => subject.sessions.transact(address, () => Effect.succeed({ drafts: [{ kind: "host.changed", data: { n } }], result: undefined })), { concurrency: 1 })
    yield* TestClock.adjust("9 millis")
    expect(yield* Ref.get(calls)).toBe(1)
    yield* TestClock.adjust("1 millis")
    yield* eventually(subject.sessions.read(address, { kinds: ["turn.ended"] }), (events) => events.length === 2)
    expect(yield* Ref.get(calls)).toBe(2)
    yield* activity.idle
    yield* TestClock.adjust("19 millis")
    expect(yield* Ref.get(calls)).toBe(2)
    yield* TestClock.adjust("1 millis")
    const events = yield* eventually(subject.sessions.read(address, { kinds: ["turn.ended"] }), (events) => events.length === 3)
    expect(events.map((event) => event.data.reason)).toEqual(["partial", "failed", "completed"])
    expect((yield* subject.sessions.get(address)).pending).toBe(0)
    expect(yield* subject.sessions.read(address, { kinds: ["inbox.queued"] })).toHaveLength(1)
    expect(yield* subject.sessions.read(address, { kinds: ["inbox.dropped"] })).toHaveLength(0)
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))

  test("a duplicate caused by another failed claim preserves input backoff and consumes startup takeover authority", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5641)
    yield* subject.sessions.enqueue(address, queued("raced-input"))
    const foreign = yield* subject.other()
    const armed = yield* Ref.make(true)
    const rejected = yield* Deferred.make<void>()
    const begun = yield* Ref.make<ReadonlyArray<BeginTurn>>([])
    const wrapped = Sessions.of({ ...subject.sessions, begin: (address, input) => Ref.update(begun, (all) => [...all, input]).pipe(
      Effect.andThen(Ref.getAndSet(armed, false)), Effect.flatMap((first) => !first ? subject.sessions.begin(address, input) : Effect.gen(function* () {
        const competing = yield* foreign.begin(address, { _tag: "Queued", input: InboxItemId.make("raced-input"), runId: RunId.make("competing-failure") })
        yield* competing.end({ reason: "failed", failure: Option.none() }).pipe(Effect.orDie)
        yield* Deferred.succeed(rejected, undefined)
        return yield* Effect.fail(new TurnDuplicate({ session: address.id, turn: competing.admitted.turn, open: false }))
      })),
    ) })
    const calls = yield* Ref.make(0)
    const activity = yield* start(subject, InboxRunner.of({ run: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as({ outcome: "completed", reply: Option.none() })) }),
      { owners: [address.owner], concurrency: 1, takeOver: true, resume: { _tag: "Never" }, backoff: { initialMs: 10, maxMs: 10 } }, wrapped)
    yield* Deferred.await(rejected)
    yield* activity.idle
    yield* eventually(Ref.get(calls), () => false, 100)
    expect(yield* Ref.get(calls)).toBe(0)
    yield* TestClock.adjust("9 millis")
    expect(yield* Ref.get(calls)).toBe(0)
    yield* TestClock.adjust("1 millis")
    expect(yield* eventually(Ref.get(calls), (n) => n === 1)).toBe(1)
    expect((yield* Ref.get(begun)).map((input) => input.takeOver ?? false)).toEqual([true, false])
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))

  test("a foreign holder does not reset backoff for the same unacknowledged input", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5642)
    const input = queued("held-retry")
    yield* subject.sessions.enqueue(address, input)
    const foreign = yield* subject.other()
    const calls = yield* Ref.make(0)
    const runner = InboxRunner.of({ run: () => Ref.updateAndGet(calls, (count) => count + 1).pipe(
      Effect.map((count) => ({ outcome: count >= 3 ? "completed" as const : "partial" as const, reply: Option.none() })),
    ) })
    const activity = yield* start(subject, runner, { owners: [address.owner], concurrency: 1, resume: { _tag: "Never" },
      sweepIntervalMs: 1, backoff: { initialMs: 10, maxMs: 100 } })
    expect((yield* eventually(subject.sessions.read(address, { kinds: ["turn.ended"] }), (events) => events.length === 1))).toHaveLength(1)
    yield* activity.idle
    const held = yield* foreign.begin(address, { _tag: "Queued", input: input.id, runId: RunId.make("foreign-retry-holder") })
    yield* TestClock.adjust("10 millis")
    yield* Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { concurrency: 1 })
    expect(yield* Ref.get(calls)).toBe(1)
    yield* held.end({ reason: "failed", failure: Option.none() })
    yield* TestClock.adjust("19 millis")
    expect(yield* Ref.get(calls)).toBe(1)
    yield* TestClock.adjust("1 millis")
    expect((yield* eventually(subject.sessions.read(address, { kinds: ["turn.ended"] }), (events) => events.length === 3))).toHaveLength(3)
    yield* activity.idle
    expect(yield* Ref.get(calls)).toBe(2)
    yield* TestClock.adjust("20 millis")
    expect(yield* Ref.get(calls)).toBe(2)
    yield* TestClock.adjust("20 millis")
    expect((yield* eventually(subject.sessions.read(address, { kinds: ["turn.ended"] }), (events) => events.length === 4))).toHaveLength(4)
    yield* activity.idle
    expect(yield* Ref.get(calls)).toBe(3)
    expect((yield* subject.sessions.get(address)).pending).toBe(0)
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))

  test("startup takeover resumes the oldest interrupted root before queued input and a failed resume retries without takeover", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5650)
    const old = yield* subject.sessions.begin(address, { _tag: "User", runId: RunId.make("old-holder"), key: "old", command: {}, userMessage: new UserMessage({ text: "unfinished" }) })
    yield* subject.sessions.enqueue(address, queued("after-root"))
    const begun = yield* Ref.make<ReadonlyArray<BeginTurn>>([])
    const seen = yield* Ref.make<ReadonlyArray<string>>([])
    const wrapped = Sessions.of({ ...subject.sessions, begin: (address, input) => Ref.update(begun, (all) => [...all, input]).pipe(Effect.andThen(subject.sessions.begin(address, input))) })
    const runner = InboxRunner.of({ run: (writer) => Ref.updateAndGet(seen, (all) => [...all, `${writer.admitted.resumes ?? "none"}:${writer.admitted.input?.id ?? "none"}`]).pipe(Effect.flatMap((all) => all.length === 1
      ? Effect.fail(new HarnessError({ code: "memory.log", message: "resume failed" })) : Effect.succeed({ outcome: "completed", reply: Option.none() }))) })
    yield* start(subject, runner, { owners: [address.owner], concurrency: 1, takeOver: true, backoff: { initialMs: 10, maxMs: 10 } }, wrapped)
    yield* eventually(subject.sessions.read(address, { kinds: ["turn.ended"] }), (events) => events.length === 2)
    expect((yield* old.closed).reason).toBe("interrupted")
    expect(yield* Ref.get(seen)).toEqual(["1:none"])
    yield* TestClock.adjust("10 millis")
    const events = yield* eventually(subject.sessions.read(address, { kinds: ["turn.ended"] }), (events) => events.length === 4)
    expect(yield* Ref.get(seen)).toEqual(["1:none", "1:none", "none:after-root"])
    expect((yield* Ref.get(begun)).map((input) => input.takeOver ?? false)).toEqual([true, false, false])
    expect(events.map((event) => event.data.reason)).toEqual(["interrupted", "failed", "completed", "completed"])
    expect((yield* subject.sessions.get(address)).pending).toBe(0)
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))

  test("takeover permission expires after startup and a later live holder is left alone", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5660)
    const scanned = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const wrapped = Sessions.of({ ...subject.sessions, read: (address, query) => subject.sessions.read(address, query).pipe(Effect.tap(() => Deferred.succeed(scanned, undefined))) })
    yield* start(subject, InboxRunner.of({ run: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as({ outcome: "completed", reply: Option.none() })) }), { owners: [address.owner], concurrency: 1, takeOver: true, sweepIntervalMs: 10 }, wrapped)
    yield* Deferred.await(scanned)
    const live = yield* subject.sessions.begin(address, { _tag: "User", runId: RunId.make("later-live"), key: "later", command: {}, userMessage: new UserMessage({ text: "live work" }) })
    yield* subject.sessions.enqueue(address, queued("wait-for-live"))
    yield* TestClock.adjust("50 millis")
    expect(yield* Ref.get(calls)).toBe(0)
    yield* live.append([{ kind: "host.still-live", data: {} }])
    yield* live.flush
    expect(Option.map((yield* subject.sessions.get(address)).open, (open) => open.runId)).toEqual(Option.some(RunId.make("later-live")))
    yield* live.end({ reason: "cancelled", failure: Option.none() })
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))

  test("shutdown interrupts a borrowed runner and leaves queued input pending without admitting another attempt", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5670)
    yield* subject.sessions.enqueue(address, queued("interrupted-work"))
    const entered = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const runner = InboxRunner.of({ run: () => Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never)) })
    const activity = yield* start(subject, runner, { owners: [address.owner], concurrency: 1 })
    yield* Deferred.await(entered)
    const shutdown = Context.get(subject.context, TurnShutdown)
    yield* shutdown.refuse
    yield* shutdown.interrupt
    const idle = yield* activity.idle.pipe(Effect.timeoutOption("150 millis"))
    expect(Option.isSome(idle)).toBe(true)
    expect((yield* subject.sessions.get(address)).pending).toBe(1)
    yield* subject.sessions.enqueue(address, queued("after-shutdown"))
    yield* eventually(Ref.get(calls), () => false, 100)
    expect(yield* Ref.get(calls)).toBe(1)
    expect(yield* activity.running).toBe(0)
    expect((yield* subject.sessions.get(address)).pending).toBe(2)
  })).pipe(Effect.timeout("3 seconds"))))

  test("an interrupted queued root whose latest resume was explicitly cancelled is not restarted", () => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const subject = yield* real
    const address = yield* create(subject.sessions, 5680)
    yield* subject.sessions.enqueue(address, queued("cancelled-input"))
    const root = yield* subject.sessions.begin(address, { _tag: "Queued", input: InboxItemId.make("cancelled-input"), runId: RunId.make("cancelled-root") })
    yield* root.end({ reason: "interrupted", failure: Option.none() })
    const resume = yield* subject.sessions.begin(address, { _tag: "User", runId: RunId.make("cancelled-resume"), key: "resume", resumes: 1, command: {}, userMessage: new UserMessage({ text: "continue" }) })
    yield* resume.end({ reason: "cancelled", failure: Option.none() })
    const scanned = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const wrapped = Sessions.of({ ...subject.sessions, read: (address, query) => subject.sessions.read(address, query).pipe(Effect.tap(() => Deferred.succeed(scanned, undefined))) })
    yield* start(subject, InboxRunner.of({ run: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as({ outcome: "completed", reply: Option.none() })) }), { owners: [address.owner], sweepIntervalMs: 10, takeOver: true }, wrapped)
    yield* Deferred.await(scanned)
    yield* TestClock.adjust("50 millis")
    expect(yield* Ref.get(calls)).toBe(0)
    expect(yield* subject.sessions.read(address, { kinds: ["turn.started"] })).toHaveLength(2)
    expect((yield* subject.sessions.get(address)).pending).toBe(0)
  })).pipe(Effect.provide(TestClock.layer()), Effect.timeout("3 seconds"))))
})
