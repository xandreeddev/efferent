import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Logger, Option, Ref, References, Scheduler, Scope } from "effect"
import { TestClock } from "effect/testing"
import { awaitIdle, frameworkDraft, HarnessError, harnessCodeOf, LeaseExpired, MediaFingerprint, mediaFromBase64, RevisionConflict, SessionLog, SessionLogError, SessionLogMemoryLive, SessionMissing, Sessions, TurnActivity, TurnAdmission, TurnAdmissionOpen, TurnRefused, UserMessage } from "@xandreed/core"
import type { BeginTurn, JsonObject, SessionAddress, SessionLogEvent, TurnEnding, TurnError, TurnWriter } from "@xandreed/core"
import { SessionsPluginLive } from "./plugin.adapter.js"
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

/** One instance over the log with the turns it has in flight (its TurnActivity). */
const withActivity = (log: Log, config: SessionsConfig, admission: Layer.Layer<TurnAdmission> = TurnAdmissionOpen) => Layer.build(SessionsLive(config).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), admission)))).pipe(
  Effect.map((context) => ({ sessions: Context.get(context, Sessions), activity: Context.get(context, TurnActivity) })))

const processMode: SessionsConfig = { ...sessionsDefaults, ownership: { mode: "process" } }

/** A process-owned instance over the log as if in a process of its own: `self` names it, `running` are the pids its host runs. */
const processOver = (log: Log, self: Option.Option<HolderProcess>, running: ReadonlyArray<number>) => Effect.service(Sessions).pipe(Effect.provide(
  SessionsLive(processMode, { liveness: { current: Effect.succeed(self), alive: (pid) => Effect.succeed(running.includes(pid)) } }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)))))

const withLog = <A, E>(body: (log: Log) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(Effect.service(SessionLog).pipe(Effect.provide(SessionLogMemoryLive), Effect.flatMap(body))).pipe(Effect.provide(TestClock.layer())))

const lease = (ttlMs: number, renew: SessionsConfig["ownership"] extends infer O ? O extends { readonly renew: infer R } ? R : never : never): SessionsConfig =>
  ({ ...sessionsDefaults, ownership: { mode: "lease", ttlMs, renew } })

/** Leases renewed only by writes (no keep-alive): the commit sequences a rebase sees are the turn's own. */
const onCommit = lease(60_000, "on-commit")

/** A leased instance over the log that names its own process (`self`) and asks which pids of its host run: how it judges a process-held turn. */
const leasedOver = (log: Log, self: Option.Option<HolderProcess>, running: ReadonlyArray<number>) => Effect.service(Sessions).pipe(Effect.provide(
  SessionsLive(onCommit, { liveness: { current: Effect.succeed(self), alive: (pid) => Effect.succeed(running.includes(pid)) } }).pipe(
    Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)))))

const created = (sessions: Service) => sessions.create({ owner }).pipe(Effect.map((view): SessionAddress => ({ id: view.header.id, owner })))
const kinds = (events: ReadonlyArray<SessionLogEvent>) => events.map((event) => `${event.kind}${Option.match(event.turn, { onNone: () => "", onSome: (turn) => `@${turn}` })}`)
const all = (sessions: Service, address: SessionAddress) => sessions.read(address).pipe(Effect.map(kinds))
/** A turn's failure by its framework code (`harnessCodeOf`), else its tag. */
const codeOf = (error: TurnError): string => Option.getOrElse(harnessCodeOf(error), () => error._tag)

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

  test("a run id names one turn: a begin reusing one of the session's, or of the history a fork inherits, is RunIdReused and opens nothing", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const under = (runId: string, key: string, resumes?: number): BeginTurn =>
      ({ _tag: "User", userMessage: new UserMessage({ text: key }), runId, key, command: {}, ...(resumes === undefined ? {} : { resumes }) })
    const refusal = (at: SessionAddress, input: BeginTurn) => Effect.flip(Effect.scoped(sessions!.begin(at, input))).pipe(
      Effect.map((error) => error._tag === "RunIdReused" ? [error._tag, error.runId, error.turn] : [error._tag]))
    yield* Effect.scoped(sessions!.begin(address, under("run-a", "k1")).pipe(Effect.flatMap((writer) => writer.end({ reason: "cancelled", failure: Option.none() }))))
    // The same key is still the same turn; a new key, a resume of the cancelled turn or an inbox turn under the run id is not.
    expect(yield* refusal(address, under("run-a", "k1"))).toEqual(["TurnDuplicate"])
    expect(yield* refusal(address, under("run-a", "k2"))).toEqual(["RunIdReused", "run-a", 1])
    expect(yield* refusal(address, under("run-a", "resume:1", 1))).toEqual(["RunIdReused", "run-a", 1])
    yield* sessions!.deliver(address, { id: "i1", source: { kind: "task" }, content: "the result of i1" })
    expect(yield* refusal(address, { _tag: "Inbox", runId: "run-a" })).toEqual(["RunIdReused", "run-a", 1])
    expect([(yield* sessions!.get(address)).turns, (yield* sessions!.get(address)).pending]).toEqual([1, 1])
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "turn.ended@1", "inbox.queued"])
    // A fork inherits its parent's turns up to the fork point, and their run ids with them.
    const fork = yield* sessions!.fork(address, { origin: "conformance", inherit: true })
    const child: SessionAddress = { id: fork.header.id, owner }
    expect(yield* refusal(child, under("run-a", "k1"))).toEqual(["RunIdReused", "run-a", 1])
    const resumed = yield* Effect.scoped(sessions!.begin(address, under("run-b", "resume:1", 1)).pipe(Effect.map((writer) => writer.admitted.turn)))
    expect(resumed).toBe(2)
    expect((yield* Effect.scoped(sessions!.begin(child, under("run-b", "k1")))).admitted.turn).toBe(2)
  })))

  test("a message's images are normalised once: stored and admitted so, a retry with the same images is the same turn, other images conflict", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const pixel = yield* mediaFromBase64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", { name: "pixel.png" })
    const careless = { ...pixel, mediaType: "image/gif" as const, bytes: 1, fingerprint: MediaFingerprint.make("00000000deadbeef") }
    const asked = (attachments: ReadonlyArray<typeof pixel>, key = "k1"): BeginTurn =>
      ({ _tag: "User", userMessage: new UserMessage({ text: "", attachments }), runId: `run-${key}`, key, command: {} })
    const writer = yield* sessions!.begin(address, asked([careless]))
    expect(writer.admitted.userMessage.attachments).toEqual([pixel])
    expect(writer.started.data.userMessage).toEqual({ text: "", attachments: [pixel] })
    expect(Option.isNone((yield* sessions!.get(address)).title)).toBe(true)
    const retried = yield* Effect.flip(sessions!.begin(address, asked([careless])))
    expect(retried._tag).toBe("TurnDuplicate")
    const other = yield* Effect.flip(sessions!.begin(address, asked([{ ...pixel, name: "renamed.png" }])))
    expect(other._tag).toBe("KeyConflict")
    const rejected = yield* Effect.flip(sessions!.begin(address, asked([{ ...pixel, data: "aGVsbG8gd29ybGQ=" }], "k2")))
    expect([rejected._tag, rejected._tag === "AttachmentRejected" ? rejected.reason : null]).toEqual(["AttachmentRejected", "UnsupportedType"])
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1"])
  })))

  test("writes are stored in order, stamped with the turn; the end closes it and the next turn can begin", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* sessions!.begin(address, say("one"))
      yield* writer.append([{ kind: "answer.started", data: { step: 0 } }, { kind: "answer.published", data: { text: "hi" } }])
      const written = yield* writer.write(Effect.succeed("in order"))
      expect(written).toBe("in order")
      yield* writer.append([{ kind: "answer.ended", data: { step: 0 } }])
      const ended = yield* writer.end({ reason: "completed", failure: Option.none() })
      expect(ended.pending).toBe(0)
      const late = yield* Effect.flip(writer.append([{ kind: "late", data: {} }]))
      expect(codeOf(late)).toBe("turn.closed")
    }))
    expect(Option.isNone((yield* sessions!.get(address)).open)).toBe(true)
    const next = yield* Effect.scoped(sessions!.begin(address, say("two")).pipe(Effect.map((writer) => writer.admitted.turn)))
    expect(next).toBe(2)
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "answer.started@1", "answer.published@1", "answer.ended@1", "turn.ended@1", "turn.started@2", "turn.ended@2"])
  })))

  test("the host's meta is stored when given and shown on the writer, and a retry with other meta is the same turn", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const meta = (value: JsonObject): BeginTurn => ({ _tag: "User", userMessage: new UserMessage({ text: "find alpha" }), runId: "run-k1", key: "k1", command: {}, meta: value })
    const writer = yield* sessions!.begin(address, meta({ request: "r1", tenant: "acme" }))
    expect(writer.admitted.meta).toEqual({ request: "r1", tenant: "acme" })
    expect(writer.started.data.meta).toEqual({ request: "r1", tenant: "acme" })
    // The key's fingerprint is the message, the command and `resumes`: other metadata, or none, is a retry of the same turn.
    const retried = yield* Effect.flip(sessions!.begin(address, meta({ request: "r2" })))
    expect([retried._tag, retried._tag === "TurnDuplicate" ? retried.turn : null]).toEqual(["TurnDuplicate", 1])
    yield* writer.end({ reason: "completed", failure: Option.none() })
    expect((yield* Effect.flip(sessions!.begin(address, say("find alpha", "k1"))))._tag).toBe("TurnDuplicate")
    // Without meta nothing is written: the stored turn.started is the same as before meta existed.
    const plain = yield* Effect.scoped(sessions!.begin(address, say("plain", "k2")).pipe(Effect.map((other) => [other.admitted.meta, "meta" in other.started.data])))
    expect(plain).toEqual([{}, false])
    const stored = yield* sessions!.read(address, { kinds: ["turn.started"] })
    expect(stored.map((event) => event.data.meta ?? null)).toEqual([{ request: "r1", tenant: "acme" }, null])
  })))

  test("a turn whose scope closes without an end ends as failed (turn.unended), or interrupted (turn.interrupted) when the scope was interrupted", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* Effect.scoped(sessions!.begin(address, say("left open")))
    const begun = yield* Deferred.make<void>()
    const held = yield* Effect.forkChild(Effect.scoped(sessions!.begin(address, say("interrupted")).pipe(
      Effect.andThen(Deferred.succeed(begun, undefined)), Effect.andThen(Effect.never))))
    yield* Deferred.await(begun)
    yield* Fiber.interrupt(held)
    const events = yield* sessions!.read(address, { kinds: ["turn.ended"] })
    expect(events.map((event) => [event.data.reason, (event.data.failure as JsonObject | null)?.code])).toEqual([["failed", "turn.unended"], ["interrupted", "turn.interrupted"]])
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
    expect([codeOf(late), late.message]).toEqual(["turn.closed", "turn 1 is ending"])
    expect(codeOf(yield* Effect.flip(writer.write(Ref.set(changed, true))))).toBe("turn.closed")
    const refused = yield* Effect.flip(writer.transact(() => Effect.succeed({ drafts: [{ kind: "late", data: {} }], result: undefined })))
    expect(codeOf(refused)).toBe("turn.closed")
    yield* Deferred.succeed(release, undefined)
    expect(yield* Fiber.join(first)).toEqual({ pending: 0 })
    expect(yield* Fiber.join(second)).toEqual({ pending: 0 })
    expect(yield* writer.end({ reason: "completed", failure: Option.none() })).toEqual({ pending: 0 })
    const after = yield* Effect.flip(writer.write(Ref.set(changed, true)))
    expect([codeOf(after), after.message]).toEqual(["turn.closed", "turn 1 has ended"])
    expect(yield* Ref.get(changed)).toBe(false)
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "answer.published@1", "turn.ended@1"])
  })))

  test("an end the store refuses is tried again, by a later end or by the scope's own with that same ending", () => withLog((inner) => Effect.gen(function* () {
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
      expect(codeOf(yield* Effect.flip(writer.end({ reason: "completed", failure: Option.none() })))).toBe("session.log")
      yield* writer.append([{ kind: "after.refusal", data: {} }])
      expect(yield* writer.end({ reason: "completed", failure: Option.none() })).toEqual({ pending: 0 })
    }))
    // The scope's end stores the ending the turn tried, not `turn.unended` or `turn.interrupted`.
    const refusedThenClosed = (text: string, ending: TurnEnding, closing: Exit.Exit<unknown, unknown>) => Effect.gen(function* () {
      const scope = yield* Scope.make()
      const writer = yield* sessions!.begin(address, say(text)).pipe(Scope.provide(scope))
      yield* Ref.set(refusals, 1)
      expect(codeOf(yield* Effect.flip(writer.end(ending)))).toBe("session.log")
      yield* Scope.close(scope, closing)
      expect(Option.isNone((yield* sessions!.get(address)).open)).toBe(true)
    })
    yield* refusedThenClosed("two", { reason: "completed", failure: Option.none() }, Exit.void)
    yield* refusedThenClosed("three", { reason: "failed", failure: Option.some({ code: "host.failed", message: "the host failed" }) }, Exit.interrupt())
    expect((yield* Effect.scoped(sessions!.begin(address, say("four")))).admitted.turn).toBe(4)
    expect((yield* sessions!.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data.reason, (event.data.failure as JsonObject | null)?.code ?? null]))
      .toEqual([[1, "completed", null], [2, "completed", null], [3, "failed", "host.failed"], [4, "failed", "turn.unended"]])
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

  test("an end the store refuses reopens admission in one step: an end begun meanwhile stays sealed, and nothing is stored after the turn's end", () => withLog((inner) => Effect.gen(function* () {
    // What the refused commit starts, on a fiber of its own, as it answers: a second end, then a write.
    const meanwhile = yield* Ref.make(Option.none<Effect.Effect<void>>())
    const log = SessionLog.of({
      ...inner,
      commit: (id, commit) => commit.events.some((event) => event.kind === "turn.ended")
        ? Ref.getAndSet(meanwhile, Option.none()).pipe(Effect.flatMap(Option.match({
          onNone: () => inner.commit(id, commit),
          onSome: (start) => Effect.forkDetach(start.pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 10_000))).pipe(
            Effect.andThen(Effect.fail(new SessionLogError({ code: "store.busy", message: "try again" })))),
        })))
        : inner.commit(id, commit),
    })
    const [sessions] = yield* instancesOver(log, onCommit)
    const completed = { reason: "completed", failure: Option.none() } as const
    // The writer yields every two steps; the second end runs unbroken between its own yields, and begins one yield
    // later each time: so its admission lands, whole, at every point of the writer settling the refusal.
    const stored = yield* Effect.forEach(Array.from({ length: 30 }, (_, steps) => steps), (steps) => Effect.scoped(Effect.gen(function* () {
      const address = yield* created(sessions!)
      const writer = yield* sessions!.begin(address, say(`try ${steps}`))
      const done = yield* Deferred.make<void>()
      yield* Ref.set(meanwhile, Option.some(Effect.gen(function* () {
        yield* Effect.forEach(Array.from({ length: steps }), () => Effect.yieldNow, { discard: true })
        yield* Effect.result(writer.end(completed))
        yield* Effect.result(writer.append([{ kind: "late", data: {} }]))
        yield* Effect.result(writer.flush)
      }).pipe(Effect.ensuring(Deferred.succeed(done, undefined)))))
      expect(codeOf(yield* Effect.flip(writer.end(completed)))).toBe("session.log")
      yield* Deferred.await(done)
      yield* Effect.result(writer.end(completed))
      const kinds = yield* all(sessions!, address)
      return kinds.slice(kinds.indexOf("turn.ended@1") + 1)
    })))
    expect(stored.flat()).toEqual([])
  }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 3))), 30_000)

  test("an append whose commit dies with a defect fails the writer's later writes with session.defect, logged with its cause, instead of leaving them waiting", () => {
    const logged: Array<readonly [string, string, unknown]> = []
    const capture = Logger.layer([Logger.make((options) => {
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
      logged.push([options.logLevel, [options.message].flat().join(" "), annotations["efferent.turn"]])
    })])
    return withLog((inner) => Effect.gen(function* () {
      const log = SessionLog.of({
        ...inner,
        commit: (id, commit) => commit.events.some((event) => event.kind === "answer.broken") ? Effect.die(new Error("the store threw")) : inner.commit(id, commit),
      })
      const [sessions] = yield* instancesOver(log, sessionsDefaults)
      const address = yield* created(sessions!)
      const scope = yield* Scope.make()
      const writer = yield* sessions!.begin(address, say("broken store")).pipe(Scope.provide(scope))
      yield* writer.append([{ kind: "answer.broken", data: {} }])
      const refused = yield* Effect.flip(writer.flush)
      expect([codeOf(refused), refused.message]).toEqual(["session.defect", "a write of turn 1 died: the store threw"])
      const later = [
        yield* Effect.flip(writer.append([{ kind: "answer.after", data: {} }])),
        yield* Effect.flip(writer.write(Effect.void)),
        yield* Effect.flip(writer.transact(() => Effect.succeed({ drafts: [{ kind: "answer.after", data: {} }], result: undefined }))),
        yield* Effect.flip(writer.end({ reason: "completed", failure: Option.none() })),
      ]
      expect(later.map(codeOf)).toEqual(["session.defect", "session.defect", "session.defect", "session.defect"])
      expect(logged).toContainEqual(["Error", "turn 1's writer stopped storing: a write died with a defect", 1])
      yield* Scope.close(scope, Exit.void)
      // The writer let the turn go unended: the next begin reaps it.
      expect((yield* Effect.scoped(sessions!.begin(address, say("next")))).admitted.turn).toBe(2)
      expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "turn.ended@1", "turn.started@2", "turn.ended@2"])
    }).pipe(Effect.provide(capture)))
  })

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
    expect(results.map((result) => result._tag === "Failure" ? codeOf(result.failure) : "success")).toEqual(["turn.closed", "turn.closed", "turn.closed"])
    expect(codeOf(yield* Effect.flip(writer.flush))).toBe("turn.closed")
    expect(codeOf(yield* Effect.flip(writer.end({ reason: "completed", failure: Option.none() })))).toBe("turn.closed")
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
    expect(codeOf(refused)).toBe("turn.closed")
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
    expect(codeOf(yield* Effect.flip(writer.flush))).toBe("turn.closed")
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

  test("the default keep-alive renews an idle turn one interval after its begin, bumping the head's updatedAt", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("idle"))
    const begun = yield* log.head(address.id)
    // The begin's own commit set the lease: no renewal follows it at once.
    yield* TestClock.adjust("19 seconds")
    expect((yield* log.head(address.id)).revision).toBe(begun.revision)
    yield* TestClock.adjust("1 second")
    yield* writer.flush
    const renewed = yield* log.head(address.id)
    expect([renewed.revision, renewed.seq, renewed.updatedAt - begun.updatedAt]).toEqual([begun.revision + 1, begun.seq, 20_000])
    expect(Option.flatMap((yield* sessions!.get(address)).open, (open) => open.expiresAt)).toEqual(Option.some(renewed.updatedAt + 60_000))
    yield* writer.end({ reason: "completed", failure: Option.none() })
    yield* TestClock.adjust("40 seconds")
    // An ended turn renews nothing.
    expect((yield* log.head(address.id)).revision).toBe(begun.revision + 2)
  })))

  test("a silent step longer than the lease keeps it with the keep-alive, and loses it when only commits renew", () => withLog((log) => Effect.gen(function* () {
    const silentStep = (config: SessionsConfig) => Effect.gen(function* () {
      const [holder, other] = yield* instancesOver(log, config, config)
      const address = yield* created(holder!)
      const writer = yield* holder!.begin(address, say("a slow model call"))
      // Ninety seconds without a write: longer than the 60 s lease.
      yield* Effect.forEach([1, 2, 3, 4, 5, 6, 7, 8, 9], () => TestClock.adjust("10 seconds"), { discard: true })
      yield* writer.append([{ kind: "answer.published", data: { step: 0 } }])
      const stored = yield* Effect.result(writer.flush)
      const next = yield* Effect.result(other!.begin(address, say("next")))
      return [stored._tag === "Success" ? "stored" : codeOf(stored.failure), next._tag === "Failure" ? next.failure._tag : `turn ${next.success.admitted.turn}`]
    })
    expect(yield* silentStep(sessionsDefaults)).toEqual(["stored", "SessionBusy"])
    expect(yield* silentStep(lease(60_000, "on-commit"))).toEqual(["turn.closed", "turn 2"])
  })))

  test("a keep-alive slower than half the lease is refused when the layer is built, as the plugin's options", () => withLog((log) => Effect.gen(function* () {
    const services = Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)
    const direct = yield* Effect.flip(Layer.build(SessionsLive(lease(1_000, { everyMs: 600 })).pipe(Layer.provide(services))))
    expect([direct.code, direct.message]).toEqual(["config.options", expect.stringContaining("renew.everyMs (600) must be at most half of ttlMs (1000)")])
    const options = yield* Effect.flip(Layer.build(SessionsPluginLive({ ownership: { mode: "lease", ttlMs: 60_000, renew: { everyMs: 40_000 } } }).pipe(Layer.provide(services))))
    expect([options.code, options.message]).toEqual(["config.options", expect.stringContaining("renew.everyMs (40000) must be at most half of ttlMs (60000)")])
    const half = yield* instancesOver(log, lease(1_000, { everyMs: 500 }))
    expect(half).toHaveLength(1)
  })))

  test("the plugin's options need only the settings they change, at any depth: the rest keep their defaults", () => withLog((log) => Effect.gen(function* () {
    const services = Layer.merge(Layer.succeed(SessionLog, log), TurnAdmissionOpen)
    const built = yield* Effect.forEach([
      { inbox: { maxPending: 50 } },
      { writer: { batch: 8 }, retries: 3 },
      { ownership: { mode: "lease", ttlMs: 120_000 } },
      { ownership: { mode: "process" } },
    ] as const, (options) => Layer.build(SessionsPluginLive(options).pipe(Layer.provide(services))).pipe(Effect.as("built"), Effect.catch((error) => Effect.succeed(error.code))))
    expect(built).toEqual(["built", "built", "built", "built"])
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

  test("a turn is judged as it was taken, whatever the reader's ownership: under a lease, a process-held turn is held while its process runs, then reaped", () => withLog((log) => Effect.gen(function* () {
    const holder = yield* processOver(log, Option.some({ host: "h1", pid: 101, startedAt: 1 }), [101])
    const address = yield* created(holder)
    yield* holder.begin(address, say("process-held"))
    const whileRunning = yield* leasedOver(log, Option.some({ host: "h1", pid: 202, startedAt: 2 }), [101, 202])
    expect(Option.map((yield* whileRunning.get(address)).open, (open) => open.turn)).toEqual(Option.some(1))
    expect((yield* Effect.flip(whileRunning.begin(address, say("while it runs"))))._tag).toBe("SessionBusy")
    const afterIt = yield* leasedOver(log, Option.some({ host: "h1", pid: 202, startedAt: 2 }), [202])
    expect(Option.isNone((yield* afterIt.get(address)).open)).toBe(true)
    expect((yield* afterIt.begin(address, say("after it stopped"))).admitted.turn).toBe(2)
    // A process-held turn that names no process holds nothing for a leased reader either.
    const unnamed = yield* processOver(log, Option.none(), [])
    const other = yield* created(unnamed)
    yield* unnamed.begin(other, say("unnamed"))
    expect((yield* afterIt.begin(other, say("after the unnamed one"))).admitted.turn).toBe(2)
    const ended = (yield* afterIt.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data.reason, (event.data.failure as JsonObject | null)?.code ?? null])
    expect(ended).toEqual([[1, "interrupted", "turn.lease"]])
  })))

  test("under process ownership, a turn whose end the store refuses, at its scope's close too, is logged and let go of by its instance: the next begin reaps it", () => {
    const logged: Array<readonly [string, unknown, unknown]> = []
    const capture = Logger.layer([Logger.make((options) => {
      const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
      logged.push([[options.message].flat().join(" "), annotations["efferent.session.id"], annotations["efferent.turn"]])
    })])
    return withLog((inner) => Effect.gen(function* () {
      const refusing = yield* Ref.make(false)
      const log = SessionLog.of({
        ...inner,
        commit: (id, commit) => Ref.get(refusing).pipe(Effect.flatMap((refuse) => refuse && commit.events.some((event) => event.kind === "turn.ended")
          ? Effect.fail(new SessionLogError({ code: "store.busy", message: "the store is busy" }))
          : inner.commit(id, commit))),
      })
      const sessions = yield* processOver(log, Option.some({ host: "h1", pid: 101, startedAt: 1 }), [101])
      const address = yield* created(sessions)
      const scope = yield* Scope.make()
      const writer = yield* sessions.begin(address, say("never stored")).pipe(Scope.provide(scope))
      yield* Ref.set(refusing, true)
      expect(codeOf(yield* Effect.flip(writer.end({ reason: "completed", failure: Option.none() })))).toBe("session.log")
      yield* Scope.close(scope, Exit.void)
      yield* Ref.set(refusing, false)
      // This process still runs, but its instance let the turn go: not busy until the process exits.
      expect(Option.isNone((yield* sessions.get(address)).open)).toBe(true)
      expect((yield* Effect.scoped(sessions.begin(address, say("next")))).admitted.turn).toBe(2)
      const ended = (yield* sessions.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data.reason, (event.data.failure as JsonObject | null)?.code ?? null])
      expect(ended).toEqual([[1, "interrupted", "turn.lease"], [2, "failed", "turn.unended"]])
      expect(logged).toContainEqual(["turn 1's end was not stored when its scope closed: session.log: the store is busy", address.id, 1])
    }).pipe(Effect.provide(capture)))
  })

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
    expect(codeOf(yield* Effect.flip(writer.flush))).toBe("turn.closed")
  })))
})

describe("activity", () => {
  test("TurnActivity lists the turns this instance holds open, oldest first, each from its begin until its writer's scope closes", () => withLog((log) => Effect.gen(function* () {
    const { sessions, activity } = yield* withActivity(log, sessionsDefaults)
    const [other] = yield* instancesOver(log, sessionsDefaults)
    const first = yield* created(sessions)
    const second = yield* created(sessions)
    const opened = activity.current.pipe(Effect.map((now) => now.open.map((open) => [open.session, open.turn])))
    expect(yield* activity.current).toEqual({ open: [], beginning: 0 })
    yield* activity.idle
    yield* TestClock.adjust("1 second")
    const scope = yield* Scope.make()
    const writer = yield* sessions.begin(first, say("one")).pipe(Scope.provide(scope))
    yield* TestClock.adjust("1 second")
    yield* Effect.scoped(Effect.gen(function* () {
      yield* sessions.begin(second, say("two"))
      expect(yield* activity.current).toEqual({ open: [{ session: first.id, turn: 1, since: 1_000 }, { session: second.id, turn: 1, since: 2_000 }], beginning: 0 })
    }))
    // A turn another instance holds is that instance's.
    const elsewhere = yield* created(other!)
    yield* Effect.scoped(other!.begin(elsewhere, say("elsewhere")).pipe(Effect.andThen(Effect.gen(function* () {
      expect(yield* opened).toEqual([[first.id, 1]])
    }))))
    const idle = yield* Effect.forkChild(activity.idle)
    yield* writer.end({ reason: "completed", failure: Option.none() })
    yield* Effect.yieldNow
    // Ended but its scope still open: it still counts, and so does the session's next turn, begun meanwhile.
    expect([yield* opened, idle.pollUnsafe()]).toEqual([[[first.id, 1]], undefined])
    const next = yield* Scope.make()
    yield* sessions.begin(first, say("three")).pipe(Scope.provide(next))
    expect(yield* opened).toEqual([[first.id, 1], [first.id, 2]])
    yield* Scope.close(scope, Exit.void)
    expect([yield* opened, idle.pollUnsafe()]).toEqual([[[first.id, 2]], undefined])
    yield* Scope.close(next, Exit.void)
    yield* Fiber.join(idle)
    expect(yield* activity.current).toEqual({ open: [], beginning: 0 })
  })))

  test("a begin counts from before the host's admission, through a slow commit, until its writer is held: awaitIdle waits for it", () => withLog((log) => Effect.gen(function* () {
    const mode = yield* Ref.make<"queue" | "refuse" | "refuse after opening">("queue")
    const queued = yield* Deferred.make<void>()
    const admitted = yield* Deferred.make<void>()
    const storing = yield* Deferred.make<void>()
    const stored = yield* Deferred.make<void>()
    // The opening commit waits on the store, as one on SQLite waits out another connection's lock.
    const slow: Log = { ...log, commit: (id, input) => (input.events.some((event) => event.kind === "turn.started")
      ? Deferred.succeed(storing, undefined).pipe(Effect.andThen(Deferred.await(stored)))
      : Effect.void).pipe(Effect.andThen(log.commit(id, input))) }
    const admission = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (turn, open) => Ref.get(mode).pipe(Effect.flatMap((now) => now === "refuse"
        ? Effect.fail(new TurnRefused({ session: turn.session.id, reason: "draining", message: "draining" }))
        : now === "refuse after opening"
          ? open.pipe(Effect.andThen(Effect.fail(new TurnRefused({ session: turn.session.id, reason: "draining", message: "refused after it opened" }))))
          : Deferred.succeed(queued, undefined).pipe(Effect.andThen(Deferred.await(admitted)), Effect.andThen(open)))),
    }))
    const { sessions, activity } = yield* withActivity(slow, sessionsDefaults, admission)
    const address = yield* created(sessions)
    const scope = yield* Scope.make()
    const beginning = yield* Effect.forkChild(sessions.begin(address, say("queued")).pipe(Scope.provide(scope)))
    yield* Deferred.await(queued)
    // Queued in the host's admission: no turn yet, but the begin counts.
    expect(yield* activity.current).toEqual({ open: [], beginning: 1 })
    const drained = yield* Effect.forkChild(awaitIdle().pipe(Effect.provideService(TurnActivity, activity)))
    yield* Deferred.succeed(admitted, undefined)
    yield* Deferred.await(storing)
    // Admitted, its commit waiting on the store: it still counts.
    yield* TestClock.adjust("3 seconds")
    expect([yield* activity.current, drained.pollUnsafe()]).toEqual([{ open: [], beginning: 1 }, undefined])
    yield* Deferred.succeed(stored, undefined)
    const writer = yield* Fiber.join(beginning)
    // Handed over: one update moves it from beginning to open, since after its commit.
    expect(yield* activity.current).toEqual({ open: [{ session: address.id, turn: 1, since: 3_000 }], beginning: 0 })
    yield* writer.end({ reason: "completed", failure: Option.none() })
    yield* Effect.yieldNow
    expect(drained.pollUnsafe()).toBeUndefined()
    yield* Scope.close(scope, Exit.void)
    expect(yield* Fiber.join(drained)).toEqual({ openTurns: [], beginningTurns: 0, runningTasks: 0, busy: false })

    // A refused begin stops counting at once, though its scope stays open.
    const kept = yield* Scope.make()
    yield* Ref.set(mode, "refuse")
    const refused = yield* Effect.flip(sessions.begin(address, say("refused")).pipe(Scope.provide(kept)))
    expect([refused._tag, yield* activity.current]).toEqual(["TurnRefused", { open: [], beginning: 0 }])
    // One refused after its turn was committed counts until its scope has closed that turn.
    yield* Ref.set(mode, "refuse after opening")
    const late = yield* Effect.flip(sessions.begin(address, say("refused late")).pipe(Scope.provide(kept)))
    expect([late._tag, yield* activity.current]).toEqual(["TurnRefused", { open: [], beginning: 1 }])
    yield* Scope.close(kept, Exit.void)
    expect(yield* activity.current).toEqual({ open: [], beginning: 0 })
    expect((yield* sessions.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data.reason])).toEqual([[1, "completed"], [2, "failed"]])
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
    expect(results.map((result) => result._tag === "Failure" ? codeOf(result.failure) : "success")).toEqual(["turn.closed", "turn.closed"])
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
    expect(results.map((result) => result._tag === "Failure" ? codeOf(result.failure) : "success")).toEqual(["turn.closed", "turn.closed"])
    yield* Scope.close(scope, Exit.void)
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "turn.ended@1"])
  })))

  test("a cancel on the holder's instance closes its writer at once", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("stop me"))
    expect((yield* sessions!.cancel(address, 1)).cancelled).toBe(true)
    expect((yield* writer.closed).reason).toBe("cancelled")
    expect(codeOf(yield* Effect.flip(writer.append([{ kind: "after", data: {} }])))).toBe("turn.closed")
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "turn.ended@1"])
  })))

  test("a cancel from another instance is refused to the holder at its next write", () => withLog((log) => Effect.gen(function* () {
    const [holder, other] = yield* instancesOver(log, sessionsDefaults, sessionsDefaults)
    const address = yield* created(holder!)
    const writer = yield* holder!.begin(address, say("elsewhere"))
    expect((yield* other!.cancel(address, 1)).cancelled).toBe(true)
    yield* writer.append([{ kind: "after", data: {} }])
    expect(codeOf(yield* Effect.flip(writer.flush))).toBe("turn.closed")
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
    expect(codeOf(yield* Effect.flip(writer.flush))).toBe("turn.closed")
    expect((yield* writer.closed).reason).toBe("interrupted")
    expect(codeOf(yield* Effect.flip(writer.append([{ kind: "later", data: {} }])))).toBe("turn.closed")
  })))

  test("a turn nobody holds any more is reaped by a cancel as by a delivery: in either order it ends interrupted and its items wait again", () => withLog((log) => Effect.gen(function* () {
    const short = lease(1_000, "on-commit")
    const [holder, other] = yield* instancesOver(log, short, short)
    const item = { id: "i1", source: { kind: "task" }, content: "the result of i1" }
    // An inbox turn whose holder stopped: it took the item, and its lease ran out.
    const crashed = Effect.gen(function* () {
      const address = yield* created(holder!)
      yield* holder!.deliver(address, item)
      yield* holder!.begin(address, { _tag: "Inbox", runId: `run-${address.id}` })
      yield* TestClock.adjust("2 seconds")
      return address
    })
    const outcome = (address: SessionAddress) => Effect.gen(function* () {
      const ended = (yield* other!.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data.reason, (event.data.failure as JsonObject | null)?.code ?? null])
      const view = yield* other!.get(address)
      return { ended, open: Option.isSome(view.open), pending: view.pending }
    })
    const cancelFirst = yield* crashed
    const cancelled = yield* other!.cancel(cancelFirst, 1)
    const reapFirst = yield* crashed
    yield* other!.deliver(reapFirst, item)
    const afterReap = yield* other!.cancel(reapFirst, 1)
    expect([cancelled, afterReap]).toEqual([{ cancelled: false, pending: 1 }, { cancelled: false, pending: 1 }])
    const expected = { ended: [[1, "interrupted", "turn.lease"]], open: false, pending: 1 }
    expect([yield* outcome(cancelFirst), yield* outcome(reapFirst)]).toEqual([expected, expected])
    // The item is taken again by the next drain, whichever came first.
    const drained = [yield* other!.drain(cancelFirst, () => Effect.void), yield* other!.drain(reapFirst, () => Effect.void)]
    expect(drained.map((done) => done.turns)).toEqual([1, 1])
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
    const [sessions] = yield* instancesOver(log, onCommit)
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
    const [sessions] = yield* instancesOver(log, onCommit)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("show a page"))
    yield* sessions!.transact(address, () => Effect.succeed({ drafts: [{ kind: "canvas.frozen", data: { page: "p1" } }], result: undefined }))
    expect(codeOf(yield* Effect.flip(writer.transact(plan)))).toBe("session.log")
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
    const [sessions] = yield* instancesOver(log, onCommit)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("show a page"))
    yield* sessions!.transact(address, () => Effect.succeed({ drafts: [{ kind: "canvas.frozen", data: {} }], result: undefined }))
    const seen = yield* Ref.make<ReadonlyArray<ReadonlyArray<string>>>([])
    yield* writer.transact((foreign) => Ref.update(seen, (snapshots) => [...snapshots, foreign.map((event) => event.kind)]).pipe(Effect.andThen(plan(foreign))))
    expect(yield* Ref.get(seen)).toEqual([[], ["canvas.frozen"], ["canvas.frozen", "canvas.updated"]])
  })))

  test("a host may not record under the framework's kinds", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, onCommit)
    const address = yield* created(sessions!)
    const refused = yield* Effect.flip(sessions!.transact(address, () => Effect.succeed({ drafts: [{ kind: "turn.ended", data: {} }], result: undefined })))
    expect(refused._tag).toBe("ReservedKind")
  })))

  test("a turn's writer stores the framework's kinds only from the framework's turn: anyone else's append or transact under one stores nothing", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, onCommit)
    const address = yield* created(sessions!)
    const writer = yield* sessions!.begin(address, say("one"))
    const refused = [
      yield* Effect.flip(writer.append([{ kind: "answer.published", data: {} }, { kind: "turn.ended", data: { reason: "completed", failure: null } }])),
      yield* Effect.flip(writer.append([{ kind: "step.usage", data: { step: 0 } }])),
      yield* Effect.flip(writer.transact(() => Effect.succeed({ drafts: [{ kind: "memory.message", data: {} }], result: undefined }))),
      yield* Effect.flip(writer.transact(() => Effect.succeed({ drafts: [{ kind: "inbox.dropped", data: { id: "i1", reason: "attempts" } }], result: undefined }))),
    ]
    expect(refused.map((error) => [codeOf(error), error.message])).toEqual([
      ["events.reserved", "turn.ended is the framework's kind"],
      ["events.reserved", "step.usage is the framework's kind"],
      ["events.reserved", "memory.message is the framework's kind"],
      ["events.reserved", "inbox.dropped is the framework's kind"],
    ])
    // Nothing of a refused call is stored, the turn is still open, and the writer goes on.
    expect(Option.map((yield* sessions!.get(address)).open, (open) => open.turn)).toEqual(Option.some(1))
    yield* writer.append([frameworkDraft("step.started", { step: 0 }), { kind: "answer.published", data: { text: "hi" } }])
    yield* writer.end({ reason: "completed", failure: Option.none() })
    expect(yield* all(sessions!, address)).toEqual(["turn.started@1", "step.started@1", "answer.published@1", "turn.ended@1"])
  })))
})

describe("contention and a broken log", () => {
  test("a write that keeps losing to other writers fails with SessionContended after the configured attempts, and stores nothing", () => withLog((inner) => Effect.gen(function* () {
    const conflicting = yield* Ref.make(false)
    const tries = yield* Ref.make(0)
    const log = SessionLog.of({
      ...inner,
      commit: (id, commit) => Ref.get(conflicting).pipe(Effect.flatMap((conflict) => conflict
        ? Ref.update(tries, (n) => n + 1).pipe(Effect.andThen(Effect.fail(new RevisionConflict({ session: id, expected: commit.expect, actual: commit.expect + 1 }))))
        : inner.commit(id, commit))),
    })
    const [sessions] = yield* instancesOver(log, { ...sessionsDefaults, retries: 3 })
    const address = yield* created(sessions!)
    const held = yield* created(sessions!)
    const writer = yield* sessions!.begin(held, say("held"))
    yield* sessions!.deliver(address, { id: "i1", source: {}, content: "waiting" })
    yield* Ref.set(conflicting, true)
    const contended = [
      yield* Effect.flip(sessions!.transact(address, () => Effect.succeed({ drafts: [{ kind: "note", data: {} }], result: undefined }))),
      yield* Effect.flip(sessions!.deliver(address, { id: "i2", source: {}, content: "another" })),
      yield* Effect.flip(Effect.scoped(sessions!.begin(address, say("one")))),
      yield* Effect.flip(sessions!.drain(address, () => Effect.void)),
      yield* Effect.flip(sessions!.cancel(held, writer.admitted.turn)),
    ]
    expect(contended.map((error) => error._tag === "SessionContended" ? [error._tag, error.session === held.id ? "held" : "address", error.attempts] : [error._tag])).toEqual([
      ["SessionContended", "address", 3],
      ["SessionContended", "address", 3],
      ["SessionContended", "address", 3],
      ["SessionContended", "address", 3],
      ["SessionContended", "held", 3],
    ])
    expect(yield* Ref.get(tries)).toBe(15)
    yield* Ref.set(conflicting, false)
    expect(yield* all(sessions!, address)).toEqual(["inbox.queued"])
    expect(Option.map((yield* sessions!.get(held)).open, (open) => open.turn)).toEqual(Option.some(1))
  })))

  test("a log that answers what its contract rules out is a defect, not a SessionLogError", () => withLog((inner) => Effect.gen(function* () {
    const broken = yield* Ref.make(false)
    const log = SessionLog.of({
      ...inner,
      // A session created without a parent reported missing.
      create: (header) => Ref.get(broken).pipe(Effect.flatMap((on) => on ? Effect.fail(new SessionMissing({ session: header.id })) : inner.create(header))),
      commit: (id, commit) => Ref.get(broken).pipe(Effect.flatMap((on) => !on ? inner.commit(id, commit)
        // A turn's opening commit stored, and answered without its events.
        : commit.events.some((event) => event.kind === "turn.started") ? inner.commit(id, commit).pipe(Effect.map((committed) => ({ ...committed, events: [] })))
        // A commit without `notAfter` refused as expired.
        : commit.events.some((event) => event.kind === "note") ? Effect.fail(new LeaseExpired({ session: id, notAfter: 0, now: 1 }))
        : inner.commit(id, commit))),
    })
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* Ref.set(broken, true)
    const exits: ReadonlyArray<Exit.Exit<unknown, unknown>> = [
      yield* Effect.exit(sessions!.create({ owner })),
      yield* Effect.exit(Effect.scoped(sessions!.begin(address, say("one")))),
      yield* Effect.exit(sessions!.transact(address, () => Effect.succeed({ drafts: [{ kind: "note", data: {} }], result: undefined }))),
    ]
    expect(exits.map((exit) => [Exit.hasDies(exit), Option.isNone(Exit.findErrorOption(exit))])).toEqual([[true, true], [true, true], [true, true]])
    // The turn whose begin died was closed by its scope.
    expect(Option.isNone((yield* sessions!.get(address)).open)).toBe(true)
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

  test("a drain goes on while its own turns' ends leave items waiting, and stops at the end that leaves none", () => withLog((log) => Effect.gen(function* () {
    const admitted = yield* Ref.make(0)
    const counting = Layer.succeed(TurnAdmission, TurnAdmission.of({ admit: (_turn, open) => Ref.update(admitted, (count) => count + 1).pipe(Effect.andThen(open)) }))
    const { sessions } = yield* withActivity(log, sessionsDefaults, counting)
    const address = yield* created(sessions)
    yield* sessions.deliver(address, item("t1"))
    // The first inbox turn's run delivers another item: its end counts it, so the drain takes it next.
    const drained = yield* sessions.drain(address, (writer) => writer.admitted.claimed.some((claimed) => claimed.id === "t1")
      ? sessions.deliver(address, item("t2")).pipe(Effect.asVoid)
      : record("second")(writer))
    // Two turns, two admissions: no begin after the end that left nothing waiting.
    expect([drained.turns, yield* Ref.get(admitted), (yield* sessions.get(address)).pending]).toEqual([2, 2, 0])
    expect(yield* all(sessions, address)).toEqual(["inbox.queued", "turn.started@1", "inbox.queued", "turn.ended@1", "turn.started@2", "answer.published@2", "turn.ended@2"])
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

  test("an item whose turn fails waits again, and is dropped after too many attempts; each turn stores its failure's code", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.deliver(address, item("t1"))
    const failing = () => Effect.fail("the model is down")
    const coded = () => Effect.fail(new HarnessError({ code: "model.unavailable", message: "no provider answered" }))
    expect((yield* sessions!.drain(address, failing, { maxTurns: 1 })).turns).toBe(1)
    expect((yield* sessions!.get(address)).pending).toBe(1)
    expect((yield* sessions!.drain(address, coded, { maxTurns: 1 })).turns).toBe(1)
    expect((yield* sessions!.get(address)).pending).toBe(0)
    expect((yield* sessions!.read(address, { kinds: ["inbox.dropped"] })).map((event) => event.data.id)).toEqual(["t1"])
    expect((yield* sessions!.read(address, { kinds: ["turn.ended"] })).map((event) => [event.data.reason, event.data.failure])).toEqual([
      ["failed", { code: "turn.failed", message: "the model is down" }],
      ["failed", { code: "model.unavailable", message: "no provider answered" }],
    ])
  })))

  test("an inbox turn interrupted before it wrote anything did not try its items: no attempt is counted", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.deliver(address, item("t1"))
    const interrupted = { reason: "interrupted", failure: Option.some({ code: "host.deadline", message: "out of time" }) } as const
    const untried = (writer: TurnWriter) => writer.end(interrupted).pipe(Effect.asVoid)
    const tried = (writer: TurnWriter) => writer.append([{ kind: "answer.published", data: { text: "half" } }]).pipe(Effect.andThen(writer.end(interrupted)), Effect.asVoid)
    yield* Effect.forEach([1, 2, 3], () => sessions!.drain(address, untried, { maxTurns: 1 }), { discard: true })
    expect((yield* sessions!.get(address)).pending).toBe(1)
    yield* sessions!.drain(address, tried, { maxTurns: 1 })
    expect((yield* sessions!.get(address)).pending).toBe(1)
    yield* sessions!.drain(address, tried, { maxTurns: 1 })
    expect((yield* sessions!.get(address)).pending).toBe(0)
    expect((yield* sessions!.read(address, { kinds: ["inbox.dropped"] })).map((event) => [Option.getOrNull(event.turn), event.data.id])).toEqual([[5, "t1"]])
  })))

  test("an inbox turn whose run interrupts itself ends interrupted and counts an attempt; one interrupted from outside counts none", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.deliver(address, item("t1"))
    const entered = yield* Deferred.make<void>()
    const held = yield* Effect.forkChild(sessions!.drain(address, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))))
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(held)
    expect((yield* sessions!.get(address)).pending).toBe(1)
    // The default `inbox.attempts` is 2: two runs that interrupt themselves drop the item, and the drain stops.
    expect((yield* sessions!.drain(address, () => Effect.interrupt)).turns).toBe(2)
    expect((yield* sessions!.get(address)).pending).toBe(0)
    expect((yield* sessions!.read(address, { kinds: ["inbox.dropped"] })).map((event) => [Option.getOrNull(event.turn), event.data.id])).toEqual([[3, "t1"]])
    expect((yield* sessions!.read(address, { kinds: ["turn.ended"] })).map((event) => [event.data.reason, (event.data.failure as JsonObject | null)?.code]))
      .toEqual([["interrupted", "turn.interrupted"], ["interrupted", "turn.interrupted"], ["interrupted", "turn.interrupted"]])
  })))

  test("a HarnessError a run carries as a defect is stored with its own code; any other defect is turn.defect", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, { ...sessionsDefaults, inbox: { ...sessionsDefaults.inbox, attempts: 3 } })
    const address = yield* created(sessions!)
    yield* sessions!.deliver(address, item("t1"))
    yield* sessions!.drain(address, () => Effect.die(new HarnessError({ code: "reaction.failed", message: "broken" })), { maxTurns: 1 })
    yield* sessions!.drain(address, () => Effect.die(new Error("boom")), { maxTurns: 1 })
    expect((yield* sessions!.read(address, { kinds: ["turn.ended"] })).map((event) => event.data.failure))
      .toEqual([{ code: "reaction.failed", message: "broken" }, { code: "turn.defect", message: "Error: boom" }])
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

describe("resuming a turn", () => {
  const resume = (turn: number, text = "Continue.", key = `resume:${turn}`): BeginTurn =>
    ({ _tag: "User", userMessage: new UserMessage({ text }), runId: `run-${key}-${text}`, key, command: {}, resumes: turn })
  const completed = (writer: TurnWriter) => writer.end({ reason: "completed", failure: Option.none() })
  /** The turn the begin opened and the turn it resumes, as admitted and as stored; the begin's scope closes the turn. */
  const opened = (sessions: Service, address: SessionAddress, input: BeginTurn) => Effect.scoped(sessions.begin(address, input).pipe(
    Effect.tap(completed), Effect.map((writer) => [writer.admitted.turn, writer.admitted.resumes ?? null, writer.started.data.resumes ?? null])))
  const refusal = (sessions: Service, address: SessionAddress, input: BeginTurn) => Effect.flip(Effect.scoped(sessions.begin(address, input))).pipe(
    Effect.map((error) => error._tag === "NotResumable" ? [error._tag, error.turn, error.reason] : [error._tag]))

  test("a cancelled turn is resumed by a new user's turn: resumes is stored, admitted and part of the key's fingerprint", () => withLog((log) => Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<unknown>>([])
    const recording = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (turn, open) => Ref.update(seen, (all) => [...all, [turn.key, turn.resumes ?? null]]).pipe(Effect.andThen(open)),
    }))
    const sessions = yield* Effect.service(Sessions).pipe(Effect.provide(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), recording)))))
    const address = yield* created(sessions)
    const writer = yield* sessions.begin(address, say("find alpha", "k1"))
    yield* writer.append([{ kind: "answer.published", data: { text: "half" } }])
    yield* writer.flush
    expect((yield* sessions.cancel(address, 1)).cancelled).toBe(true)
    expect(yield* opened(sessions, address, resume(1))).toEqual([2, 1, 1])
    // A retry with the resume's key is the turn it began, however that turn ended; the same key for anything else conflicts.
    const retried = yield* Effect.flip(Effect.scoped(sessions.begin(address, resume(1))))
    expect([retried._tag, retried._tag === "TurnDuplicate" ? retried.turn : null]).toEqual(["TurnDuplicate", 2])
    expect((yield* Effect.flip(Effect.scoped(sessions.begin(address, say("Continue.", "resume:1")))))._tag).toBe("KeyConflict")
    // A turn that resumes nothing is stored and admitted without the key.
    yield* Effect.scoped(sessions.begin(address, say("next", "k3")).pipe(Effect.flatMap(completed)))
    const stored = yield* sessions.read(address, { kinds: ["turn.started"] })
    expect(stored.map((event) => [event.data.key, "resumes" in event.data ? event.data.resumes : "absent"])).toEqual([["k1", "absent"], ["resume:1", 1], ["k3", "absent"]])
    expect(yield* Ref.get(seen)).toEqual([["k1", null], ["resume:1", 1], ["resume:1", 1], ["resume:1", null], ["k3", null]])
    expect(yield* all(sessions, address)).toEqual(["turn.started@1", "answer.published@1", "turn.ended@1", "turn.started@2", "turn.ended@2", "turn.started@3", "turn.ended@3"])
  })))

  test("an interrupted turn is resumed, and so is one reaped when its lease ran out, by the begin that reaps it or after", () => withLog((log) => Effect.gen(function* () {
    const [sessions, first, second] = yield* instancesOver(log, sessionsDefaults, lease(1_000, "none"), lease(1_000, "none"))
    const address = yield* created(sessions!)
    const begun = yield* Deferred.make<void>()
    const held = yield* Effect.forkChild(Effect.scoped(sessions!.begin(address, say("interrupted")).pipe(Effect.andThen(Deferred.succeed(begun, undefined)), Effect.andThen(Effect.never))))
    yield* Deferred.await(begun)
    yield* Fiber.interrupt(held)
    expect(yield* opened(sessions!, address, resume(1))).toEqual([2, 1, 1])
    // A holder that stops writing: the resume's own begin reaps its turn and resumes it.
    yield* first!.begin(address, say("abandoned"))
    yield* TestClock.adjust("2 seconds")
    expect(yield* opened(second!, address, resume(3))).toEqual([4, 3, 3])
    // Reaped earlier, by another begin's touch (a delivery): still interrupted, still resumable.
    yield* first!.begin(address, say("abandoned again"))
    yield* TestClock.adjust("2 seconds")
    yield* second!.deliver(address, { id: "i1", source: {}, content: "a notice" })
    expect(yield* opened(second!, address, resume(5))).toEqual([6, 5, 5])
    const ended = yield* sessions!.read(address, { kinds: ["turn.ended"] })
    expect(ended.map((event) => [Option.getOrNull(event.turn), event.data.reason, (event.data.failure as JsonObject | null)?.code ?? null])).toEqual([
      [1, "interrupted", "turn.interrupted"], [2, "completed", null], [3, "interrupted", "turn.lease"], [4, "completed", null], [5, "interrupted", "turn.lease"], [6, "completed", null],
    ])
  })))

  test("inbox turns after the resumed turn do not supersede it", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.begin(address, say("stop me"))
    yield* sessions!.deliver(address, { id: "i1", source: {}, content: "a notice" })
    yield* sessions!.cancel(address, 1)
    expect((yield* sessions!.drain(address, () => Effect.void)).turns).toBe(1)
    expect(yield* opened(sessions!, address, resume(1))).toEqual([3, 1, 1])
  })))

  test("a turn that cannot be resumed is refused with why, after a duplicate key and a busy session, and nothing is opened", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* Effect.scoped(sessions!.begin(address, say("one")).pipe(Effect.flatMap(completed)))
    expect(yield* refusal(sessions!, address, resume(1))).toEqual(["NotResumable", 1, "finished"])
    expect(yield* refusal(sessions!, address, resume(7))).toEqual(["NotResumable", 7, "missing"])
    // A scope that closed without an end failed (turn.unended): not resumable.
    yield* Effect.scoped(sessions!.begin(address, say("left open")))
    expect(yield* refusal(sessions!, address, resume(2))).toEqual(["NotResumable", 2, "finished"])
    // An inbox turn is never resumed, even when it was interrupted.
    yield* sessions!.deliver(address, { id: "i1", source: {}, content: "a notice" })
    yield* sessions!.drain(address, () => Effect.interrupt, { maxTurns: 1 })
    expect(yield* refusal(sessions!, address, resume(3))).toEqual(["NotResumable", 3, "inbox"])
    // A cancelled turn a later user's turn followed is superseded.
    yield* sessions!.begin(address, say("cancelled"))
    yield* sessions!.cancel(address, 4)
    yield* Effect.scoped(sessions!.begin(address, say("after it")).pipe(Effect.flatMap(completed)))
    expect(yield* refusal(sessions!, address, resume(4))).toEqual(["NotResumable", 4, "superseded"])
    // A busy session answers SessionBusy first, and a used key before anything else: here KeyConflict, the key "open" was begun without `resumes`.
    const writer = yield* sessions!.begin(address, say("open"))
    expect(yield* refusal(sessions!, address, resume(5))).toEqual(["SessionBusy"])
    expect(yield* refusal(sessions!, address, resume(4, "open", "open"))).toEqual(["KeyConflict"])
    yield* writer.end({ reason: "cancelled", failure: Option.none() })
    const before = yield* sessions!.get(address)
    expect(yield* refusal(sessions!, address, resume(1))).toEqual(["NotResumable", 1, "superseded"])
    const after = yield* sessions!.get(address)
    expect([after.turns, after.seq, Option.isNone(after.open)]).toEqual([before.turns, before.seq, true])
  })))

  test("a retried resume while the resuming turn is open is that turn (TurnDuplicate, open), not SessionBusy", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.begin(address, say("stop me"))
    yield* sessions!.cancel(address, 1)
    const writer = yield* sessions!.begin(address, resume(1))
    const retried = yield* Effect.flip(Effect.scoped(sessions!.begin(address, resume(1))))
    expect([retried._tag, retried._tag === "TurnDuplicate" ? [retried.turn, retried.open] : null]).toEqual(["TurnDuplicate", [2, true]])
    // Another message under the open resume's key conflicts; a begin with a new key is busy.
    expect(yield* refusal(sessions!, address, resume(1, "other"))).toEqual(["KeyConflict"])
    expect(yield* refusal(sessions!, address, resume(1, "Continue.", "resume:1:again"))).toEqual(["SessionBusy"])
    yield* completed(writer)
  })))

  test("a resume that failed, was cancelled or was interrupted can be tried again with a new key; a completed one supersedes the turn", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.begin(address, say("stop me"))
    yield* sessions!.cancel(address, 1)
    // The resume fails (its provider was down): its key is that failed turn, and a new key tries the resume again.
    const failed = (writer: TurnWriter) => writer.end({ reason: "failed", failure: Option.some({ code: "provider.unavailable", message: "the provider was down" }) })
    yield* Effect.scoped(sessions!.begin(address, resume(1)).pipe(Effect.flatMap(failed)))
    expect(yield* refusal(sessions!, address, resume(1))).toEqual(["TurnDuplicate"])
    expect(yield* refusal(sessions!, address, resume(2))).toEqual(["NotResumable", 2, "finished"])
    // Tried again and cancelled: turn 1 can still be resumed with a new key.
    yield* sessions!.begin(address, resume(1, "Continue.", "resume:1:2"))
    yield* sessions!.cancel(address, 3)
    // Tried again and interrupted (its holder stopped): the same.
    const begun = yield* Deferred.make<void>()
    const held = yield* Effect.forkChild(Effect.scoped(sessions!.begin(address, resume(1, "Continue.", "resume:1:3")).pipe(Effect.andThen(Deferred.succeed(begun, undefined)), Effect.andThen(Effect.never))))
    yield* Deferred.await(begun)
    yield* Fiber.interrupt(held)
    expect(yield* opened(sessions!, address, resume(1, "Continue.", "resume:1:4"))).toEqual([5, 1, 1])
    // The completed resume supersedes turn 1 and the resumes before it.
    expect(yield* refusal(sessions!, address, resume(1, "Continue.", "resume:1:5"))).toEqual(["NotResumable", 1, "superseded"])
    expect(yield* refusal(sessions!, address, resume(3))).toEqual(["NotResumable", 3, "superseded"])
    const ended = yield* sessions!.read(address, { kinds: ["turn.ended"] })
    expect(ended.map((event) => [Option.getOrNull(event.turn), event.data.reason])).toEqual([[1, "cancelled"], [2, "failed"], [3, "cancelled"], [4, "interrupted"], [5, "completed"]])
  })))

  test("a resumes that is not a whole number of at least 1 is missing, refused before the host's admission", () => withLog((log) => Effect.gen(function* () {
    const admitted = yield* Ref.make(0)
    const counting = Layer.succeed(TurnAdmission, TurnAdmission.of({ admit: (_turn, open) => Ref.update(admitted, (count) => count + 1).pipe(Effect.andThen(open)) }))
    const sessions = yield* Effect.service(Sessions).pipe(Effect.provide(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), counting)))))
    const address = yield* created(sessions)
    yield* sessions.begin(address, say("stop me"))
    yield* sessions.cancel(address, 1)
    const refused = yield* Effect.forEach([1.5, Number.NaN, 0, -1, Number.POSITIVE_INFINITY], (turn) => refusal(sessions, address, resume(turn)))
    expect(refused).toEqual([1.5, Number.NaN, 0, -1, Number.POSITIVE_INFINITY].map((turn) => ["NotResumable", turn, "missing"]))
    expect(yield* Ref.get(admitted)).toBe(1)
    expect(yield* opened(sessions, address, resume(1))).toEqual([2, 1, 1])
  })))

  test("a fork's inherited turns are its parent's: the fork cannot resume them", () => withLog((log) => Effect.gen(function* () {
    const [sessions] = yield* instancesOver(log, sessionsDefaults)
    const address = yield* created(sessions!)
    yield* sessions!.begin(address, say("cancelled"))
    yield* sessions!.cancel(address, 1)
    const child = yield* sessions!.fork(address, { origin: "task", inherit: true })
    expect(yield* refusal(sessions!, { id: child.header.id, owner }, resume(1))).toEqual(["NotResumable", 1, "missing"])
    expect(yield* opened(sessions!, address, resume(1))).toEqual([2, 1, 1])
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

  test("the host's admission sees each turn's meta, the inbox's from drain, and {} when none was given", () => withLog((log) => Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<JsonObject>>([])
    const recording = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (turn, open) => Ref.update(seen, (all) => [...all, turn.meta]).pipe(Effect.andThen(open)),
    }))
    const sessions = yield* Effect.service(Sessions).pipe(Effect.provide(SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(Layer.succeed(SessionLog, log), recording)))))
    const address = yield* created(sessions)
    const ended = (writer: TurnWriter) => writer.end({ reason: "completed", failure: Option.none() })
    yield* Effect.scoped(sessions.begin(address, { ...say("one", "k1"), meta: { tenant: "acme" } }).pipe(Effect.flatMap(ended)))
    yield* sessions.deliver(address, { id: "i1", source: {}, content: "a notice" })
    const drained = yield* Ref.make<ReadonlyArray<unknown>>([])
    yield* sessions.drain(address, (writer) => Ref.set(drained, [writer.admitted.origin, writer.admitted.meta, writer.started.data.meta]), { maxTurns: 1, meta: { source: "drain" } })
    expect(yield* Ref.get(drained)).toEqual(["inbox", { source: "drain" }, { source: "drain" }])
    yield* Effect.scoped(sessions.begin(address, say("two", "k2")).pipe(Effect.flatMap(ended)))
    expect(yield* Ref.get(seen)).toEqual([{ tenant: "acme" }, { source: "drain" }, {}])
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
    expect((yield* sessions.read(address, { kinds: ["turn.ended"] })).map((event) => [Option.getOrNull(event.turn), event.data.reason, (event.data.failure as JsonObject | null)?.code]))
      .toEqual([[1, "interrupted", "turn.interrupted"]])
    expect((yield* sessions.get(address)).pending).toBe(1)
    yield* Ref.set(stalling, false)
    expect((yield* Effect.scoped(sessions.begin(address, say("next")))).admitted.turn).toBe(2)
  })))
})
