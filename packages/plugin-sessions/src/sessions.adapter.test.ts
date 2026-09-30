import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Scope } from "effect"
import { TestClock } from "effect/testing"
import { SessionLog, SessionLogError, SessionLogMemoryLive, Sessions, TurnAdmission, TurnAdmissionOpen, TurnRefused, UserMessage } from "@xandreed/core"
import type { BeginTurn, SessionAddress, SessionLogEvent } from "@xandreed/core"
import { processLiveness } from "./process-liveness.adapter.js"
import { SessionsLive } from "./sessions.adapter.js"
import { sessionsDefaults } from "./sessions-state.entity.js"
import type { HolderProcess, SessionsConfig } from "./sessions-state.entity.js"

type Log = Context.Service.Shape<typeof SessionLog>
type Service = Context.Service.Shape<typeof Sessions>

const owner = "owner-1"
const say = (text: string, key = text, command: Record<string, unknown> = {}): BeginTurn =>
  ({ _tag: "User", userMessage: new UserMessage({ text }), runId: `run-${key}`, key, command })

/** Sessions instances over one shared log: as if on several servers. */
const instancesOver = (log: Log, ...configs: ReadonlyArray<SessionsConfig>) => Effect.forEach(configs, (config) =>
  Effect.service(Sessions).pipe(Effect.provide(SessionsLive(config).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen))))))

const processMode: SessionsConfig = { ...sessionsDefaults, ownership: { mode: "process" } }

/** A process-owned instance over the log as if in a process of its own: `self` names it, `running` are the pids its host runs. */
const processOver = (log: Log, self: Option.Option<HolderProcess>, running: ReadonlyArray<number>) => Effect.service(Sessions).pipe(Effect.provide(
  SessionsLive(processMode, { liveness: { current: Effect.succeed(self), alive: (pid) => Effect.succeed(running.includes(pid)) } }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)))))

const withLog = <A, E>(body: (log: Log) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive), Effect.flatMap(body))).pipe(Effect.provide(TestClock.layer())))

const lease = (ttlMs: number, renew: SessionsConfig["ownership"] extends infer O ? O extends { readonly renew: infer R } ? R : never : never): SessionsConfig =>
  ({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew } })

const created = (sessions: Service) => sessions.create({ owner }).pipe(Effect.map((view): SessionAddress => ({ id: view.header.id, owner })))
const kinds = (events: ReadonlyArray<SessionLogEvent>) => events.map((event) => `${event.kind}${Option.match(event.turn, { onNone: () => "", onSome: (turn) => `@${turn}` })}`)
const all = (sessions: Service, address: SessionAddress) => sessions.read(address).pipe(Effect.map(kinds))

describe("one turn at a time", () => {
  test("a turn opens with the message stored once; a second message is busy, a retry is the same turn, a changed retry conflicts", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("find alpha", "k1", { canvas: "c1" }))
    expect(writer.admitted.turn).toBe(1)
    const view = yield* sessions!.get(address)
    expect(Option.map(view.open, (open) => [open.turn, open.key])).toEqual(Option.some([1, "k1"]))
    expect(Option.getOrNull(view.title)).toBe("find alpha")
    const busy = yield* Effect.flip(sessions!.begin(address, say("another", "k2")))
    expect(busy._tag).toBe("SessionBusy")
    const again = yield* Effect.flip(sessions!.begin(address, say("find alpha", "k1", { canvas: "c1" })))
    expect([again._tag, again._tag === "TurnDuplicate" ? again.open : null]).toEqual(["TurnDuplicate", true])
    const changedText = yield* Effect.flip(sessions!.begin(address, say("find beta", "k1", { canvas: "c1" })))
    const changedCommand = yield* Effect.flip(sessions!.begin(address, say("find alpha", "k1", { canvas: "c2" })))
    expect([changedText._tag, changedCommand._tag]).toEqual(["KeyConflict", "KeyConflict"])
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1"])
  })))

  test("writes are stored in order, stamped with the turn; the end closes it and the next turn can begin", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* sessions!.begin(address, say("one"))
      yield* writer.append([{ kind: "step.started", data: { step: 0 } }, { kind: "answer.published", data: { text: "hi" } }])
      const written = yield* writer.write(Effect.succeed("in order"))
      expect(written).toBe("in order")
      yield* writer.append([{ kind: "step.ended", data: { step: 0 } }])
      const ended = yield* writer.end({ reason: "completed", failure: Option.none() })
      expect(ended.pending).toBe(0)
      const late = yield* Effect.flip(writer.append([{ kind: "late", data: {} }]))
      expect(late.code).toBe("turn.closed")
    }))
    expect(Option.isNone((yield* sessions!.get(address)).open)).toBe(true)
    const next = yield* Effect.scoped(sessions!.begin(address, say("two")).pipe(Effect.map((writer) => writer.admitted.turn)))
    expect(next).toBe(2)
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "step.started@1", "answer.published@1", "step.ended@1", "turn.ended@1", "turn.started@2", "turn.ended@2"])
  })))

  test("a turn whose scope closes without an end ends as failed", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* Effect.scoped(sessions!.begin(address, say("left open")))
    const events = yield* sessions!.read(address, { kinds: ["turn.ended"] })
    expect(events.map((event) => event.data.reason)).toEqual(["failed"])
    expect(Option.isNone((yield* sessions!.get(address)).open)).toBe(true)
  })))

  test("an end seals all writes before its commit completes, and repeated ends share one commit", () => withLog((inner) => Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const log = SessionLog.of({
      ...inner,
      commit: (id, commit) => commit.events.some((event) => event.kind === "turn.ended")
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.andThen(inner.commit(id, commit)))
        : inner.commit(id, commit),
    })
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("one"))
    const changed = yield* Ref.make(false)
    yield* writer.append([{ kind: "answer.published", data: { text: "before the end" } }])
    const first = yield* Effect.forkChild(writer.end({ reason: "completed", failure: Option.none() }))
    yield* Deferred.await(entered)
    const second = yield* Effect.forkChild(writer.end({ reason: "failed", failure: Option.none() }))
    const late = yield* Effect.flip(writer.append([{ kind: "late", data: {} }]))
    expect([late.code, late.message]).toEqual(["turn.closed", "turn 1 is ending"])
    expect((yield* Effect.flip(writer.write(Ref.set(changed, true)))).code).toBe("turn.closed")
    const refused = yield* Effect.flip(writer.transact(() => Effect.succeed({ drafts: [{ kind: "late", data: {} }], result: undefined })))
    expect(refused.code).toBe("turn.closed")
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(first)).toEqual({ pending: 0 })
    expect(yield* Fiber.join(second)).toEqual({ pending: 0 })
    expect(yield* writer.end({ reason: "completed", failure: Option.none() })).toEqual({ pending: 0 })
    const after = yield* Effect.flip(writer.write(Ref.set(changed, true)))
    expect([after.code, after.message]).toEqual(["turn.closed", "turn 1 has ended"])
    expect(yield* Ref.get(changed)).toBe(false)
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "answer.published@1", "turn.ended@1"])
  })))

  test("an end the store refuses is tried again, by a later end or by the scope's own", () => withLog((inner) => Effect.gen(function* () {
    const refusals = yield* Ref.make(0)
    const log = SessionLog.of({
      ...inner,
      commit: (id, commit) => Ref.modify(refusals, (left) => commit.events.some((event) => event.kind === "turn.ended") && left > 0 ? [true, left - 1] : [false, left]).pipe(
        Effect.flatMap((refused) => refused ? Effect.fail(new SessionLogError({ code: "store.busy", message: "try again" })) : inner.commit(id, commit))),
    })
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* sessions!.begin(address, say("one"))
      yield* Ref.set(refusals, 1)
      expect((yield* Effect.flip(writer.end({ reason: "completed", failure: Option.none() }))).code).toBe("session.log")
      yield* writer.append([{ kind: "after.refusal", data: {} }])
      expect(yield* writer.end({ reason: "completed", failure: Option.none() })).toEqual({ pending: 0 })
    }))
    const scope = yield* Scope.make()
    const writer = yield* sessions!.begin(address, say("two")).pipe(Scope.provide(scope))
    yield* Ref.set(refusals, 1)
    expect((yield* Effect.flip(writer.end({ reason: "completed", failure: Option.none() }))).code).toBe("session.log")
    yield* Scope.close(scope, Exit.void)
    expect(Option.isNone((yield* sessions!.get(address)).open)).toBe(true)
    expect((yield* Effect.scoped(sessions!.begin(address, say("three")))).admitted.turn).toBe(3)
    expect((yield* sessions!.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data.reason])).toEqual([[1, "completed"], [2, "failed"], [3, "failed"]])
    expect(yield* all(sessions!, address)).toContain("after.refusal@1")
  })))

  test("an end interrupted while it waits for room in the queue leaves the writer open to a later end", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, { ...sessionsDefaults, writer: { capacity: 1, batch: 1 } })
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("full"))
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const running = yield* Effect.forkChild(writer.write(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))))
    yield* Deferred.await(entered)
    yield* writer.append([{ kind: "queued", data: {} }])
    const ending = yield* Effect.forkChild(writer.end({ reason: "completed", failure: Option.none() }))
    yield* Effect.yieldNow
    yield* Fiber.interrupt(ending)
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(running)
    yield* writer.append([{ kind: "after", data: {} }])
    expect(yield* writer.end({ reason: "completed", failure: Option.none() })).toEqual({ pending: 0 })
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "queued@1", "after@1", "turn.ended@1"])
  })))

  test("closing a blocked writer with a full queue settles running and queued callers", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, { ...sessionsDefaults, writer: { capacity: 1, batch: 1 } })
    const address = yield* created(sessions!)
    const scope = yield* Scope.make()
    const writer = yield* sessions!.begin(address, say("blocked")).pipe(Scope.provide(scope))
    const entered = yield* Deferred.make<void>()
    const running = yield* Effect.forkChild(Effect.result(writer.write(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))))
    yield* Deferred.await(entered)
    const queued = yield* Effect.forkChild(Effect.result(writer.flush))
    yield* Effect.yieldNow
    const ending = yield* Effect.forkChild(Effect.result(writer.end({ reason: "completed", failure: Option.none() })))
    yield* Effect.yieldNow
    const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void))
    yield* TestClock.adjust("10 seconds")
    yield* Fiber.join(closing)
    const results = [yield* Fiber.join(running), yield* Fiber.join(queued), yield* Fiber.join(ending)]
    expect(results.map((result) => result._tag === "Failure" ? result.failure.code : "success")).toEqual(["turn.closed", "turn.closed", "turn.closed"])
    expect((yield* Effect.flip(writer.flush)).code).toBe("turn.closed")
    expect((yield* Effect.flip(writer.end({ reason: "completed", failure: Option.none() }))).code).toBe("turn.closed")
  })))
})

describe("leases", () => {
  test("an expired lease is shown closed and reaped by the next begin; the old holder's writes are refused", () => withLog((log) => Effect.gen(function* () {
    const [first, second] = yield* instancesOver(log, lease(1_000, "none"), lease(1_000, "none"))
    const address = yield* created(first!)
    const writer = yield* first!.begin(address, say("slow"))
    yield* TestClock.adjust("2 seconds")
    expect(Option.isNone((yield* second!.get(address)).open)).toBe(true)
    const next = yield* second!.begin(address, say("next"))
    expect(next.admitted.turn).toBe(2)
    yield* writer.append([{ kind: "late", data: {} }])
    const refused = yield* Effect.flip(writer.flush)
    expect(refused.code).toBe("turn.closed")
    const closed = yield* writer.closed
    expect(closed.reason).toBe("interrupted")
    expect(yield* all(second!, address)).toEqual(["turn.started@1", "turn.ended@1", "turn.started@2"])
  })))

  test("a write after the lease ran out is refused by the storage clock, with nobody reaping", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, lease(1_000, "none"))
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("slow"))
    yield* TestClock.adjust("500 millis")
    yield* writer.append([{ kind: "in-time", data: {} }])
    yield* writer.flush
    yield* TestClock.adjust("1 second")
    yield* writer.append([{ kind: "late", data: {} }])
    expect((yield* Effect.flip(writer.flush)).code).toBe("turn.closed")
    expect((yield* writer.closed).reason).toBe("interrupted")
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "in-time@1"])
  })))

  test("on-commit renewal keeps a writing turn held past its first lease", () => withLog((log) => Effect.gen(function* () {
    const [first, second] = yield* instancesOver(log, lease(1_000, "on-commit"), lease(1_000, "on-commit"))
    const address = yield* created(first!)
    const writer = yield* first!.begin(address, say("writing"))
    yield* TestClock.adjust("800 millis")
    yield* writer.append([{ kind: "progress", data: {} }])
    yield* writer.flush
    yield* TestClock.adjust("800 millis")
    expect((yield* Effect.flip(second!.begin(address, say("next"))))._tag).toBe("SessionBusy")
  })))

  test("a keep-alive holds an idle turn and notices a cancel from another instance", () => withLog((log) => Effect.gen(function* () {
    const [first, second] = yield* instancesOver(log, lease(1_000, { everyMs: 200 }), lease(1_000, { everyMs: 200 }))
    const address = yield* created(first!)
    const writer = yield* first!.begin(address, say("idle"))
    yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], () => TestClock.adjust("200 millis"), { discard: true })
    expect(Option.map((yield* second!.get(address)).open, (open) => open.turn)).toEqual(Option.some(1))
    expect((yield* second!.cancel(address, 1)).cancelled).toBe(true)
    const noticed = yield* Effect.forkChild(writer.closed)
    yield* TestClock.adjust("400 millis")
    expect((yield* Fiber.join(noticed)).reason).toBe("cancelled")
  })))

  test("under process ownership, a turn whose process stopped is reaped at the first touch, as is one that names no process", () => withLog((log) => Effect.gen(function* () {
    const crashed = yield* processOver(log, Option.some({ host: "h1", pid: 101, startedAt: 1 }), [202])
    const restarted = yield* processOver(log, Option.some({ host: "h1", pid: 202, startedAt: 2 }), [202])
    const address = yield* created(crashed)
    yield* crashed.begin(address, say("before the crash"))
    expect(Option.isNone((yield* restarted.get(address)).open)).toBe(true)
    expect((yield* restarted.begin(address, say("after the restart"))).admitted.turn).toBe(2)
    // The pid came back after a restart: a process that started later is not the one that holds the turn.
    const reborn = yield* processOver(log, Option.some({ host: "h1", pid: 202, startedAt: 3 }), [202])
    expect((yield* reborn.begin(address, say("pid reused"))).admitted.turn).toBe(3)
    // A holder that names no process (an older version, or a runtime without one) holds nothing for the others.
    const unnamed = yield* processOver(log, Option.none(), [])
    const other = yield* created(unnamed)
    yield* unnamed.begin(other, say("unnamed"))
    expect((yield* reborn.begin(other, say("after it"))).admitted.turn).toBe(2)
    const ended = yield* restarted.read(address, { kinds: ["turn.ended"] })
    expect(ended.map((event) => [Option.getOrNull(event.turn), event.data.reason])).toEqual([[1, "interrupted"], [2, "interrupted"]])
  })))

  test("under process ownership, a turn whose process runs is held: busy to begin, shown open and never reaped", () => withLog((log) => Effect.gen(function* () {
    const holder = yield* processOver(log, Option.some({ host: "h1", pid: 101, startedAt: 1 }), [101, 202])
    const others = [
      yield* processOver(log, Option.some({ host: "h1", pid: 202, startedAt: 2 }), [101, 202]),
      // Another instance of the same process: held while this process runs.
      yield* processOver(log, Option.some({ host: "h1", pid: 101, startedAt: 1 }), []),
      // Another host cannot ask whether the process runs: held.
      yield* processOver(log, Option.some({ host: "h2", pid: 303, startedAt: 3 }), []),
    ]
    const address = yield* created(holder)
    const writer = yield* holder.begin(address, say("still running"))
    yield* Effect.forEach(others, (other, index) => Effect.gen(function* () {
      expect(Option.map((yield* other.get(address)).open, (open) => open.turn)).toEqual(Option.some(1))
      const busy = yield* Effect.flip(other.begin(address, say(`second ${index}`)))
      expect([busy._tag, busy._tag === "SessionBusy" ? busy.turn : null]).toEqual(["SessionBusy", 1])
      yield* other.deliver(address, { id: `i${index}`, source: {}, content: "a notice" })
    }), { discard: true })
    yield* writer.append([{ kind: "answer.published", data: {} }])
    expect((yield* writer.end({ reason: "completed", failure: Option.none() })).pending).toBe(3)
    expect(yield* all(holder, address)).toEqual(["turn.started@1", "inbox.queued", "inbox.queued", "inbox.queued", "answer.published@1", "turn.ended@1"])
  })))

  test("the default liveness names this process and asks the host whether a pid runs", () => Effect.runPromise(Effect.gen(function* () {
    const current = Option.getOrThrow(yield* processLiveness.current)
    expect([current.pid, current.host.length > 0, current.startedAt <= Date.now()]).toEqual([process.pid, true, true])
    expect(yield* Effect.forEach([process.pid, 0, 2 ** 30], processLiveness.alive)).toEqual([true, false, false])
  })))

  test("expiry is judged by the storage clock, even when it is far from the instance's", () => withLog((inner) => Effect.gen(function* () {
    const skew = 600_000
    const log: Log = SessionLog.of({
      ...inner,
      create: (header) => inner.create(header).pipe(Effect.map((head) => ({ ...head, now: head.now + skew, updatedAt: head.updatedAt + skew }))),
      head: (id) => inner.head(id).pipe(Effect.map((head) => ({ ...head, now: head.now + skew, updatedAt: head.updatedAt + skew }))),
      commit: (id, commit) => inner.commit(id, { ...commit, notAfter: Option.map(commit.notAfter, (at) => at - skew) }).pipe(
        Effect.map((committed) => ({ ...committed, at: committed.at + skew, events: committed.events.map((event) => ({ ...event, at: event.at + skew })) })),
        Effect.mapError((error) => error._tag === "LeaseExpired" ? { ...error, notAfter: error.notAfter + skew, now: error.now + skew } as typeof error : error),
      ),
    })
    const [sessions] = yield* instancesOver(log, lease(1_000, "none"))
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("skewed"))
    yield* TestClock.adjust("500 millis")
    yield* writer.append([{ kind: "in-time", data: {} }])
    yield* writer.flush
    yield* TestClock.adjust("1 second")
    yield* writer.append([{ kind: "late", data: {} }])
    expect((yield* Effect.flip(writer.flush)).code).toBe("turn.closed")
  })))
})

describe("cancel and removal", () => {
  test("a local cancel interrupts a running write and settles its queued callers", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("blocked"))
    const entered = yield* Deferred.make<void>()
    const interrupted = yield* Deferred.make<void>()
    const running = yield* Effect.forkChild(Effect.result(writer.write(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
    )))
    yield* Deferred.await(entered)
    const queued = yield* Effect.forkChild(Effect.result(writer.flush))
    yield* Effect.yieldNow
    yield* sessions!.cancel(address, writer.admitted.turn)
    const results = [yield* Fiber.join(running), yield* Fiber.join(queued)]
    expect(results.map((result) => result._tag === "Failure" ? result.failure.code : "success")).toEqual(["turn.closed", "turn.closed"])
    yield* Deferred.await(interrupted)
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "turn.ended@1"])
  })))

  test("a local cancel settles callers queued behind a commit that hangs", () => withLog((inner) => Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const log = SessionLog.of({
      ...inner,
      commit: (id, commit) => commit.events.some((event) => event.kind === "stuck")
        ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
        : inner.commit(id, commit),
    })
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const scope = yield* Scope.make()
    const writer = yield* sessions!.begin(address, say("hung")).pipe(Scope.provide(scope))
    yield* writer.append([{ kind: "stuck", data: {} }])
    yield* Deferred.await(entered)
    const deciding = yield* Effect.forkChild(Effect.result(writer.transact(() => Effect.succeed({ drafts: [{ kind: "decided", data: {} }], result: undefined }))))
    const flushing = yield* Effect.forkChild(Effect.result(writer.flush))
    yield* Effect.yieldNow
    expect((yield* sessions!.cancel(address, 1)).cancelled).toBe(true)
    const results = [yield* Fiber.join(deciding), yield* Fiber.join(flushing)]
    expect(results.map((result) => result._tag === "Failure" ? result.failure.code : "success")).toEqual(["turn.closed", "turn.closed"])
    yield* Scope.close(scope, Exit.void)
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "turn.ended@1"])
  })))

  test("a cancel on the holder's instance closes its writer at once", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("stop me"))
    expect((yield* sessions!.cancel(address, 1)).cancelled).toBe(true)
    expect((yield* writer.closed).reason).toBe("cancelled")
    expect((yield* Effect.flip(writer.append([{ kind: "after", data: {} }]))).code).toBe("turn.closed")
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "turn.ended@1"])
  })))

  test("a cancel from another instance is refused to the holder at its next write", () => withLog((log) => Effect.gen(function* () {
    const [holder, other] = yield* instancesOver(log, sessionsDefaults, sessionsDefaults)
    const address = yield* created(holder!)
    const writer = yield* holder!.begin(address, say("elsewhere"))
    expect((yield* other!.cancel(address, 1)).cancelled).toBe(true)
    yield* writer.append([{ kind: "after", data: {} }])
    expect((yield* Effect.flip(writer.flush)).code).toBe("turn.closed")
    expect((yield* writer.closed).reason).toBe("cancelled")
  })))

  test("a turn closed elsewhere closes its writer even when the others' events cannot be read", () => withLog((inner) => Effect.gen(function* () {
    const unavailable = yield* Ref.make(false)
    const log = SessionLog.of({
      ...inner,
      read: (id, query) => Ref.get(unavailable).pipe(Effect.flatMap((down) => down && query.after > 0
        ? Effect.fail(new SessionLogError({ code: "read.unavailable", message: "history unavailable" }))
        : inner.read(id, query))),
    })
    const [holder, other] = yield* instancesOver(log, sessionsDefaults, sessionsDefaults)
    const address = yield* created(holder!)
    const writer = yield* holder!.begin(address, say("elsewhere"))
    expect((yield* other!.cancel(address, 1)).cancelled).toBe(true)
    yield* Ref.set(unavailable, true)
    yield* writer.append([{ kind: "after", data: {} }])
    expect((yield* Effect.flip(writer.flush)).code).toBe("turn.closed")
    expect((yield* writer.closed).reason).toBe("interrupted")
    expect((yield* Effect.flip(writer.append([{ kind: "later", data: {} }]))).code).toBe("turn.closed")
  })))

  test("a cancel naming an earlier turn does nothing", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* Effect.scoped(sessions!.begin(address, say("one")).pipe(Effect.flatMap((writer) => writer.end({ reason: "completed", failure: Option.none() }))))
    const second = yield* sessions!.begin(address, say("two"))
    expect((yield* sessions!.cancel(address, 1)).cancelled).toBe(false)
    expect(Option.map((yield* sessions!.get(address)).open, (open) => open.turn)).toEqual(Option.some(second.admitted.turn))
  })))

  test("removing a session closes its open turn and its children", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const child = yield* sessions!.fork(address, { origin: "task", inherit: false })
    const writer = yield* sessions!.begin(address, say("open"))
    yield* sessions!.remove(address)
    expect((yield* writer.closed).reason).toBe("removed")
    expect((yield* Effect.flip(sessions!.get(address)))._tag).toBe("SessionMissing")
    expect((yield* Effect.flip(sessions!.get({ id: child.header.id, owner })))._tag).toBe("SessionMissing")
  })))

  test("another owner sees no session", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const stranger = { ...address, owner: "someone-else" }
    const errors = [yield* Effect.flip(sessions!.get(stranger)), yield* Effect.flip(sessions!.read(stranger)), yield* Effect.flip(sessions!.cancel(stranger, 1))]
    expect(errors.map((error) => error._tag)).toEqual(["SessionMissing", "SessionMissing", "SessionMissing"])
  })))
})

describe("check, then append", () => {
  const plan = (others: ReadonlyArray<SessionLogEvent>) => Effect.succeed(others.some((event) => event.kind === "canvas.frozen")
    ? { drafts: [], result: "refused: the page is frozen" }
    : { drafts: [{ kind: "canvas.planned", data: { page: "p1" } }], result: "planned" })

  test("a decision is taken again when someone else wrote first", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("show a page"))
    yield* sessions!.transact(address, () => Effect.succeed({ drafts: [{ kind: "canvas.frozen", data: { page: "p1" } }], result: undefined }))
    const decided = yield* writer.transact(plan)
    expect(decided.result).toBe("refused: the page is frozen")
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "canvas.frozen"])
    const unconflicted = yield* sessions!.begin({ ...address, id: (yield* created(sessions!)).id }, say("another page")).pipe(Effect.flatMap((other) => other.transact(plan)))
    expect([unconflicted.result, unconflicted.events.map((event) => event.kind)]).toEqual(["planned", ["canvas.planned"]])
  })))

  test("a failed rebase read refuses the commit and a retry still sees the missing foreign facts", () => withLog((inner) => Effect.gen(function* () {
    const unavailable = yield* Ref.make(true)
    const log = SessionLog.of({
      ...inner,
      read: (id, query) => Ref.get(unavailable).pipe(Effect.flatMap((down) => down && query.after > 0
        ? Effect.fail(new SessionLogError({ code: "read.unavailable", message: "history unavailable" }))
        : inner.read(id, query))),
    })
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("show a page"))
    yield* sessions!.transact(address, () => Effect.succeed({ drafts: [{ kind: "canvas.frozen", data: { page: "p1" } }], result: undefined }))
    expect((yield* Effect.flip(writer.transact(plan))).code).toBe("session.log")
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "canvas.frozen"])
    yield* Ref.set(unavailable, false)
    expect((yield* writer.transact(plan)).result).toBe("refused: the page is frozen")
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "canvas.frozen"])
  })))

  test("a rebase takes only its head's events so a concurrent later event is observed once", () => withLog((inner) => Effect.gen(function* () {
    const injected = yield* Ref.make(false)
    const log = SessionLog.of({
      ...inner,
      read: (id, query) => Effect.gen(function* () {
        if (query.after > 0 && !(yield* Ref.modify(injected, (seen) => [seen, true]))) {
          const head = yield* inner.head(id)
          yield* inner.commit(id, { expect: head.revision, notAfter: Option.none(), state: Option.none(), events: [{ kind: "canvas.updated", turn: Option.none(), data: {} }] }).pipe(Effect.orDie)
        }
        return yield* inner.read(id, query)
      }),
    })
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("show a page"))
    yield* sessions!.transact(address, () => Effect.succeed({ drafts: [{ kind: "canvas.frozen", data: {} }], result: undefined }))
    const seen = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
    yield* writer.transact((foreign) => Ref.update(seen, (snapshots) => [...snapshots, foreign.map((event) => event.kind)]).pipe(Effect.andThen(plan(foreign))))
    expect(yield* Ref.get(seen)).toEqual([[], ["canvas.frozen"], ["canvas.frozen", "canvas.updated"]])
  })))

  test("a host may not record under the framework's kinds", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const refused = yield* Effect.flip(sessions!.transact(address, () => Effect.succeed({ drafts: [{ kind: "turn.ended", data: {} }], result: undefined })))
    expect(refused._tag).toBe("ReservedKind")
  })))
})

describe("the inbox", () => {
  const item = (id: string) => ({ id, source: { kind: "task", task: id }, content: `[Background task ${id} completed]\n<task-output>done ${id}</task-output>` })
  const record = (text: string) => (writer: { readonly append: (drafts: ReadonlyArray<{ readonly kind: string; readonly data: Record<string, unknown> }>) => Effect.Effect<void, unknown> }) =>
    writer.append([{ kind: "answer.published", data: { text } }]).pipe(Effect.orDie)

  test("an item delivered to an idle session is taken by one inbox turn, framed as its message", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    expect(yield* sessions!.deliver(address, item("t1"))).toEqual({ delivered: true, pending: 1 })
    const seen = yield* Deferred.make<ReadonlyArray<string>>()
    const drained = yield* sessions!.drain(address, (writer) => Deferred.succeed(seen, [writer.admitted.origin, writer.admitted.userMessage.text, ...writer.admitted.claimed.map((claimed) => claimed.id)]).pipe(Effect.asVoid))
    expect(drained.turns).toBe(1)
    expect(yield* Deferred.await(seen)).toEqual(["inbox", item("t1").content, "t1"])
    expect((yield* sessions!.get(address)).pending).toBe(0)
    expect(yield* all(sessions!, address)).toEqual(["inbox.queued", "turn.started@1", "turn.ended@1"])
  })))

  test("an item delivered during a turn waits for it; the turn's end reports it", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("long answer"))
    expect((yield* sessions!.deliver(address, item("t1"))).pending).toBe(1)
    expect((yield* sessions!.drain(address, record("too early"))).turns).toBe(0)
    expect((yield* writer.end({ reason: "completed", failure: Option.none() })).pending).toBe(1)
    expect((yield* sessions!.drain(address, record("after"))).turns).toBe(1)
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "inbox.queued", "turn.ended@1", "turn.started@2", "answer.published@2", "turn.ended@2"])
  })))

  test("nothing is lost when a turn's end and a delivery race", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    yield* Effect.forEach(Array.from({ length: 25 }, (_, n) => n), (n) => Effect.gen(function* () {
      const address = yield* created(sessions!)
      const scope = yield* Scope.make()
      const writer = yield* sessions!.begin(address, say(`turn ${n}`)).pipe(Scope.provide(scope))
      const closer = writer.end({ reason: "completed", failure: Option.none() }).pipe(
        Effect.flatMap((ended) => ended.pending > 0 ? sessions!.drain(address, record("closer drained")) : Effect.succeed({ turns: 0 })))
      const deliverer = sessions!.deliver(address, item(`t${n}`)).pipe(Effect.andThen(sessions!.drain(address, record("deliverer drained"))))
      const [left, right] = n % 2 === 0 ? [closer, deliverer] : [deliverer, closer]
      yield* Effect.all([left, right], { concurrency: "unbounded" })
      yield* Scope.close(scope, Exit.void)
      const view = yield* sessions!.get(address)
      expect([view.pending, Option.isNone(view.open)]).toEqual([0, true])
      const inboxTurns = (yield* sessions!.read(address, { kinds: ["turn.started"] })).filter((event) => event.data.origin === "inbox")
      expect(inboxTurns.length).toBe(1)
    }), { discard: true })
  })))

  test("the same item delivered twice is stored once, even after it is done", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.deliver(address, item("t1"))
    expect(yield* sessions!.deliver(address, item("t1"))).toEqual({ delivered: false, pending: 1 })
    yield* sessions!.drain(address, record("done"))
    expect((yield* sessions!.deliver(address, item("t1"))).delivered).toBe(false)
    expect((yield* sessions!.read(address, { kinds: ["inbox.queued"] })).length).toBe(1)
  })))

  test("an item whose turn fails waits again, and is dropped after too many attempts", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.deliver(address, item("t1"))
    const failing = () => Effect.fail("the model is down")
    expect((yield* sessions!.drain(address, failing, { maxTurns: 1 })).turns).toBe(1)
    expect((yield* sessions!.get(address)).pending).toBe(1)
    expect((yield* sessions!.drain(address, failing, { maxTurns: 1 })).turns).toBe(1)
    expect((yield* sessions!.get(address)).pending).toBe(0)
    expect((yield* sessions!.read(address, { kinds: ["inbox.dropped"] })).map((event) => event.data.id)).toEqual(["t1"])
  })))

  test("a user's message and an inbox turn race: exactly one begins", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.deliver(address, item("t1"))
    const user = Effect.scoped(sessions!.begin(address, say("hello")).pipe(Effect.flatMap((writer) => writer.end({ reason: "completed", failure: Option.none() })), Effect.as("user"))).pipe(
      Effect.catchTag("SessionBusy", () => Effect.succeed("busy")))
    const system = sessions!.drain(address, record("reaction"), { maxTurns: 1 })
    const [said, drained] = yield* Effect.all([user, system], { concurrency: "unbounded" })
    // Turns never overlap: every start is closed before the next one opens.
    const lifecycle = kinds(yield* sessions!.read(address, { kinds: ["turn.started", "turn.ended"] }))
    const turns = lifecycle.length / 2
    expect(lifecycle).toEqual(Array.from({ length: turns }, (_, index) => [`turn.started@${index + 1}`, `turn.ended@${index + 1}`]).flat())
    expect(turns).toBe((said === "user" ? 1 : 0) + drained.turns)
    expect(said === "user" || drained.turns === 1).toBe(true)
  })))

  test("a full inbox refuses more", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, { ...sessionsDefaults, inbox: { maxPending: 2, attempts: 2 } })
    const address = yield* created(sessions!)
    yield* sessions!.deliver(address, item("t1"))
    yield* sessions!.deliver(address, item("t2"))
    expect((yield* Effect.flip(sessions!.deliver(address, item("t3"))))._tag).toBe("InboxFull")
  })))
})

describe("forks", () => {
  test("a fork's history is its parent's up to the last closed turn, and its turns count on from there", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const turn = (text: string, done: boolean) => sessions!.begin(address, say(text)).pipe(Effect.flatMap((writer) =>
      writer.append([{ kind: "answer.published", data: { text } }]).pipe(Effect.andThen(done ? writer.end({ reason: "completed", failure: Option.none() }) : writer.flush))))
    yield* Effect.scoped(turn("one", true))
    yield* Effect.scoped(turn("two", true))
    const openScope = yield* Scope.make()
    yield* turn("three, still open", false).pipe(Scope.provide(openScope))
    const child = yield* sessions!.fork(address, { origin: "task", inherit: true, meta: { task: "t1" } })
    const lineage = Option.getOrThrow(child.header.parent)
    expect([lineage.turnAtFork, child.turns]).toEqual([2, 2])
    const childAddress = { id: child.header.id, owner }
    const writer = yield* sessions!.begin(childAddress, say("do the task", "task-1"))
    expect(writer.admitted.turn).toBe(3)
    const history = yield* writer.history([])
    expect(kinds(history)).toEqual(["turn.started@1", "answer.published@1", "turn.ended@1", "turn.started@2", "answer.published@2", "turn.ended@2"])
    yield* writer.append([{ kind: "answer.published", data: { text: "child answer" } }])
    expect(kinds(yield* writer.snapshot(["answer.published"]))).toEqual(["answer.published@1", "answer.published@2", "answer.published@3"])
    expect(kinds(yield* writer.history(["answer.published"]))).toEqual(["answer.published@1", "answer.published@2"])
    const spawned = yield* sessions!.fork(address, { origin: "task", inherit: false })
    const fresh = yield* Effect.scoped(sessions!.begin({ id: spawned.header.id, owner }, say("from nothing")).pipe(Effect.flatMap((other) => other.history([]))))
    expect([spawned.turns, fresh.length]).toEqual([0, 0])
    const listed = yield* sessions!.list({ owner })
    expect(listed.sessions.map((view) => view.header.id)).toEqual([address.id])
    const children = yield* sessions!.list({ owner, parent: address.id })
    expect(children.sessions.length).toBe(2)
    yield* Scope.close(openScope, Exit.void)
  })))
})

describe("admission", () => {
  test("the host admits each opening commit, not the turn's writes; a refusal opens nothing and a duplicate counts nothing", () => withLog((log) => Effect.gen(function* () {
    const admitted = yield* Ref.make<ReadonlyArray<string>>([])
    const refusing = yield* Ref.make(false)
    const counting = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (turn, open) => Effect.gen(function* () {
        if (yield* Ref.get(refusing)) return yield* Effect.fail(new TurnRefused({ session: turn.session.id, reason: "budget", message: "no turns left today" }))
        const opened = yield* open
        yield* Ref.update(admitted, (all) => [...all, `${turn.origin}:${turn.key}`])
        return opened
      }),
    }))
    const sessions = yield* Effect.service(Sessions).pipe(Effect.provide(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), counting)))))
    const address = yield* created(sessions)
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* sessions.begin(address, say("one", "k1"))
      yield* writer.append([{ kind: "answer.published", data: {} }])
      yield* writer.end({ reason: "completed", failure: Option.none() })
    }))
    expect((yield* Effect.flip(Effect.scoped(sessions.begin(address, say("one", "k1")))))._tag).toBe("TurnDuplicate")
    yield* sessions.deliver(address, { id: "i1", source: {}, content: "a notice" })
    yield* Ref.set(refusing, true)
    expect((yield* Effect.flip(Effect.scoped(sessions.begin(address, say("two", "k2")))))._tag).toBe("TurnRefused")
    expect((yield* sessions.drain(address, () => Effect.void)).turns).toBe(0)
    expect(yield* Ref.get(admitted)).toEqual(["user:k1"])
    expect(yield* all(sessions, address)).toEqual(["turn.started@1", "answer.published@1", "turn.ended@1", "inbox.queued"])
    expect((yield* sessions.get(address)).pending).toBe(1)
    yield* Ref.set(refusing, false)
    expect((yield* sessions.drain(address, () => Effect.void)).turns).toBe(1)
    expect((yield* Ref.get(admitted)).map((entry) => entry.split(":")[0])).toEqual(["user", "inbox"])
  })))

  test("a begin interrupted after its opening commit still closes the turn it opened", () => withLog((log) => Effect.gen(function* () {
    const committed = yield* Deferred.make<void>()
    const stalling = yield* Ref.make(true)
    const stalls = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (_turn, open) => open.pipe(Effect.tap(() => Ref.get(stalling).pipe(Effect.flatMap((stall) => stall
        ? Deferred.succeed(committed, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.void)))),
    }))
    const sessions = yield* Effect.service(Sessions).pipe(Effect.provide(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), stalls)))))
    const address = yield* created(sessions)
    yield* sessions.deliver(address, { id: "i1", source: {}, content: "a notice" })
    const beginning = yield* Effect.forkChild(Effect.scoped(sessions.begin(address, { _tag: "Inbox", runId: "run-late" })))
    yield* Deferred.await(committed)
    yield* Fiber.interrupt(beginning)
    expect(Option.isNone((yield* sessions.get(address)).open)).toBe(true)
    expect((yield* sessions.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data.reason])).toEqual([[1, "interrupted"]])
    yield* Ref.set(stalling, false)
    expect((yield* Effect.scoped(sessions.begin(address, say("next")))).admitted.turn).toBe(2)
  })))
})
