import { describe, expect, test } from "bun:test"
import { Clock, Context, Deferred, Effect, Exit, FiberSet, Layer, Logger, Option, Queue, Ref, References, Scope, Tracer } from "effect"
import type { Layer as LayerType } from "effect"
import { TestClock } from "effect/testing"
import {
  ConversationId,
  frameworkDraft,
  HarnessError,
  InboxItemId,
  ReservedKind,
  RunId,
  SessionContended,
  SessionLog,
  SessionLogError,
  SessionLogMemoryLive,
  Sessions,
  shutdownRefusal,
  TaskExecutor,
  TaskQuestionId,
  RunOrdinal,
  TaskRunner,
  Tasks,
  TurnAdmission,
  TurnAdmissionOpen,
  TurnRefused,
  UserMessage,
} from "@xandreed/core"
import type { JsonObject, BeginTurn, SessionAddress, SessionLogEvent, TaskView, TurnError, TurnOutcome, TurnWriter } from "@xandreed/core"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import type { SessionsConfig } from "@xandreed/plugin-sessions"
import { noticeOf } from "./task.entity.functions.js"
import { tasksDefaults } from "./task-records.entity.js"
import type { TasksConfig } from "./task-records.entity.js"
import { TasksLive } from "./tasks.adapter.js"

type SessionsService = Context.Service.Shape<typeof Sessions>
type LogService = Context.Service.Shape<typeof SessionLog>

const owner = "owner-1"
/** A task id no parent started. */
const NO_TASK = ConversationId.make("00000000-0000-4000-8000-00000000dead")
const say = (text: string, key = text): BeginTurn => ({ _tag: "User", userMessage: new UserMessage({ text }), runId: RunId.make(`run-${key}`), key, command: {} })
const ended = { reason: "completed", failure: Option.none() } as const
const kinds = (events: ReadonlyArray<SessionLogEvent>) => events.map((event) => `${event.kind}${Option.match(event.turn, { onNone: () => "", onSome: (turn) => `@${turn}` })}`)

/**
 * Sessions and Tasks over one in-memory log. The runner forks each piece of
 * work into a set the test can wait on (or drops it: a runner that died);
 * the executor's child turn is the test's, and the parent's reactions are
 * recorded as the text of the turn's message.
 */
const harness = (input: {
  readonly turn?: Context.Service.Shape<typeof TaskExecutor>["turn"]
  readonly react?: (writer: TurnWriter) => Effect.Effect<void, TurnError>
  readonly admission?: LayerType.Layer<TurnAdmission>
  readonly maxMs?: number
  readonly config?: Partial<TasksConfig>
  /** The store, as the sessions see it: the in-memory log, or a careless wrapper of it. */
  readonly log?: (inner: LogService) => LogService
  /** The sessions, as the tasks see them. */
  readonly sessions?: (inner: SessionsService) => SessionsService
} = {}) => Effect.gen(function* () {
  const reactions = yield* Ref.make<ReadonlyArray<string>>([])
  const dropping = yield* Ref.make(false)
  const fibers = yield* FiberSet.make<void>()
  const runner = Layer.succeed(TaskRunner, TaskRunner.of({
    run: (work) => Effect.gen(function* () {
      if (yield* Ref.get(dropping)) return
      const now = yield* Clock.currentTimeMillis
      yield* FiberSet.run(fibers, work(Option.map(Option.fromNullishOr(input.maxMs), (ms) => now + ms)))
    }),
  }))
  const react = (writer: TurnWriter) => Ref.update(reactions, (all) => [...all, writer.admitted.userMessage.text]).pipe(
    Effect.andThen(input.react?.(writer) ?? Effect.void),
  )
  const executor = Layer.succeed(TaskExecutor, TaskExecutor.of({
    turn: input.turn ?? ((_writer, task) => Effect.succeed({ outcome: "completed", reply: Option.some(`found: ${task.instructions}`) })),
    react,
  }))
  const logLayer = Layer.effect(SessionLog, Effect.map(Effect.service(SessionLog), input.log ?? ((log) => log))).pipe(Layer.provide(SessionLogMemoryLive))
  const sessionsLayer = Layer.effect(Sessions, Effect.map(Effect.service(Sessions), input.sessions ?? ((sessions) => sessions))).pipe(
    Layer.provide(SessionsLive(onCommit).pipe(Layer.provide(Layer.merge(logLayer, input.admission ?? TurnAdmissionOpen)))))
  const context = yield* Layer.build(TasksLive({ ...tasksDefaults, ...input.config }).pipe(Layer.provideMerge(Layer.mergeAll(sessionsLayer, runner, executor))))
  const sessions = Context.get(context, Sessions)
  const parent = yield* sessions.create({ owner }).pipe(Effect.map((view): SessionAddress => ({ id: view.header.id, owner })))
  return {
    sessions,
    withConfig: (config: Partial<TasksConfig>) => Layer.build(TasksLive({ ...tasksDefaults, ...input.config, ...config }).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sessions, sessions), runner, executor)))).pipe(Effect.map(Context.get(Tasks))),
    tasks: Context.get(context, Tasks),
    parent,
    dropping,
    idle: FiberSet.awaitEmpty(fibers),
    reactions: Ref.get(reactions),
    drain: (address: SessionAddress) => sessions.drain(address, react),
    kinds: (address: SessionAddress) => sessions.read(address).pipe(Effect.map(kinds)),
  }
})

/** Leases renewed only by writes, without the default keep-alive: an abandoned turn's lease runs out. */
const onCommit: SessionsConfig = { ...sessionsDefaults, ownership: { mode: "lease", ttlMs: 60_000, renew: "on-commit" } }

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(TestClock.layer())))

/** A logger that keeps each line's level and message, and the session and task ids it is annotated with. */
const capturing = () => {
  const logged: Array<readonly [string, string, unknown, unknown]> = []
  const layer = Logger.layer([Logger.make((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations)
    logged.push([options.logLevel, [options.message].flat().join(" "), annotations["efferent.session.id"], annotations["efferent.task.id"]])
  })])
  return { logged, layer }
}

describe("results slot in after the turn in flight", () => {
  test("a task started during a turn delivers after that turn ends, and the parent reacts once, to the notice", () => scenario(Effect.gen(function* () {
    const h = yield* harness()
    const open = yield* Scope.make()
    const writer = yield* h.sessions.begin(h.parent, say("compare the two races")).pipe(Scope.provide(open))
    const started = yield* h.tasks.start(h.parent, { instructions: "compare A and B", mode: "fork" })
    yield* h.idle
    const done = yield* h.tasks.status(h.parent, started.taskId)
    expect([done.status, Option.getOrNull(done.reply), done.delivered]).toEqual(["completed", "found: compare A and B", true])
    expect(yield* h.reactions).toEqual([])
    expect((yield* writer.end(ended)).pending).toBe(1)
    expect((yield* h.drain(h.parent)).turns).toBe(1)
    expect(yield* h.reactions).toEqual([noticeOf(done, tasksDefaults.replyChars)])
    expect(noticeOf(done, tasksDefaults.replyChars)).toBe(`[Background task ${started.taskId} completed]\n<task-output>\nfound: compare A and B\n</task-output>`)
    expect(yield* h.kinds(h.parent)).toEqual(["turn.started@1", "task.started", "inbox.queued", "turn.ended@1", "turn.started@2", "turn.ended@2"])
    expect(yield* h.kinds({ id: started.child, owner })).toEqual(["turn.started@1", "task.result@1", "turn.ended@1"])
    yield* Scope.close(open, Exit.void)
  })))

  test("a task that finishes while its parent is idle wakes it", () => scenario(Effect.gen(function* () {
    const h = yield* harness()
    const started = yield* h.tasks.start(h.parent, { instructions: "look it up", mode: "spawn" })
    yield* h.idle
    expect((yield* h.reactions).length).toBe(1)
    expect((yield* h.reactions)[0]).toContain(`[Background task ${started.taskId} completed]`)
    expect(yield* h.kinds(h.parent)).toEqual(["task.started", "inbox.queued", "turn.started@1", "turn.ended@1"])
    const [task] = yield* h.tasks.list(h.parent)
    expect([task!.status, task!.delivered, task!.mode]).toEqual(["completed", true, "spawn"])
  })))

  test("starting the same task twice runs it once", () => scenario(Effect.gen(function* () {
    const h = yield* harness()
    const first = yield* h.tasks.start(h.parent, { instructions: "once", mode: "spawn" })
    const again = yield* h.tasks.start(h.parent, { taskId: first.taskId, instructions: "once", mode: "spawn" })
    yield* h.idle
    expect(again.taskId).toBe(first.taskId)
    expect((yield* h.tasks.list(h.parent)).length).toBe(1)
    expect((yield* h.reactions).length).toBe(1)
    expect(yield* h.kinds({ id: first.child, owner })).toEqual(["turn.started@1", "task.result@1", "turn.ended@1"])
  })))
})

describe("starting and storing", () => {
  const freshTask = Effect.sync(() => ConversationId.make(crypto.randomUUID()))

  test("a start whose record the store refuses leaves no child session, and starting it again runs it once", () => scenario(Effect.gen(function* () {
    const refusing = yield* Ref.make(true)
    const h = yield* harness({
      sessions: (inner) => Sessions.of({
        ...inner,
        // Decided, then refused: a commit that kept conflicting until it gave up.
        transact: (address, decide) => Ref.get(refusing).pipe(Effect.flatMap((refuse) => refuse
          ? inner.get(address).pipe(Effect.flatMap(decide), Effect.andThen(Effect.fail(new SessionContended({ session: address.id, attempts: 3 }))))
          : inner.transact(address, decide))),
      }),
    })
    const taskId = yield* freshTask
    const refused = yield* Effect.flip(h.tasks.start(h.parent, { taskId, instructions: "not stored", mode: "fork" }))
    expect([refused._tag, refused._tag === "SessionContended" ? refused.attempts : null]).toEqual(["SessionContended", 3])
    expect((yield* h.sessions.list({ owner, parent: h.parent.id })).sessions).toEqual([])
    yield* Ref.set(refusing, false)
    const started = yield* h.tasks.start(h.parent, { taskId, instructions: "not stored", mode: "fork" })
    yield* h.idle
    expect((yield* h.tasks.status(h.parent, started.taskId)).status).toBe("completed")
    expect((yield* h.sessions.list({ owner, parent: h.parent.id })).sessions.map((view) => view.header.id)).toEqual([taskId])
    expect((yield* h.reactions).length).toBe(1)
  })))

  test("sessions that refuse the plugin's own kinds, or lose a record they stored, are a defect, not a storage failure", () => scenario(Effect.gen(function* () {
    const fault = yield* Ref.make<"none" | "reserved" | "lost">("none")
    const h = yield* harness({
      sessions: (inner) => Sessions.of({
        ...inner,
        transact: (address, decide) => Ref.get(fault).pipe(Effect.flatMap((now) => now === "reserved"
          ? Effect.fail(new ReservedKind({ kind: "task.started" }))
          : inner.transact(address, decide))),
        read: (address, query) => Ref.get(fault).pipe(Effect.flatMap((now) => inner.read(address, query).pipe(
          Effect.map((events) => now === "lost" ? events.filter((event) => event.kind !== "task.started") : events)))),
      }),
    })
    // Only the start is under test: its work is not run.
    yield* Ref.set(h.dropping, true)
    const startExit = Effect.exit(h.tasks.start(h.parent, { instructions: "faulty", mode: "spawn" }))
    yield* Ref.set(fault, "reserved")
    const reserved = yield* startExit
    yield* Ref.set(fault, "lost")
    const lost = yield* startExit
    expect([reserved, lost].map((exit) => [Exit.hasDies(exit), Option.isNone(Exit.findErrorOption(exit))])).toEqual([[true, true], [true, true]])
  })))

  test("a start that stopped after its record, before its child, is finished by starting it again", () => scenario(Effect.gen(function* () {
    const failing = yield* Ref.make(true)
    const h = yield* harness({
      sessions: (inner) => Sessions.of({
        ...inner,
        fork: (parent, input) => Ref.getAndSet(failing, false).pipe(Effect.flatMap((fail) => fail
          ? Effect.fail(new SessionLogError({ code: "store.io", message: "the store is down" }))
          : inner.fork(parent, input))),
      }),
    })
    const taskId = yield* freshTask
    expect((yield* Effect.flip(h.tasks.start(h.parent, { taskId, instructions: "half way", mode: "spawn" })))._tag).toBe("SessionLogError")
    expect([(yield* h.tasks.list(h.parent)).length, (yield* h.reactions).length]).toEqual([1, 0])
    const again = yield* h.tasks.start(h.parent, { taskId, instructions: "half way", mode: "spawn" })
    yield* h.idle
    expect((yield* h.tasks.status(h.parent, again.taskId)).status).toBe("completed")
    expect(yield* h.kinds({ id: taskId, owner })).toEqual(["turn.started@1", "task.result@1", "turn.ended@1"])
    expect((yield* h.reactions).length).toBe(1)
    // Started and run: a third start runs nothing.
    yield* h.tasks.start(h.parent, { taskId, instructions: "half way", mode: "spawn" })
    yield* h.idle
    expect((yield* h.reactions).length).toBe(1)
  })))

  test("a store failure while the task's turn is stored is logged as a failure, not as a turn closed under it", () => {
    const { logged, layer: capture } = capturing()
    return scenario(Effect.gen(function* () {
      const h = yield* harness({
        log: (inner) => SessionLog.of({
          ...inner,
          commit: (id, commit) => commit.events.some((event) => event.kind === "task.result")
            ? Effect.fail(new SessionLogError({ code: "store.io", message: "the store is down" }))
            : inner.commit(id, commit),
        }),
      })
      const task = yield* h.tasks.start(h.parent, { instructions: "unstored", mode: "spawn" })
      yield* h.idle
      expect(logged).toContainEqual(["Warn", "the background task could not store its turn: store.io: the store is down", h.parent.id, task.taskId])
      expect(logged.filter(([, message]) => message.includes("stopped"))).toEqual([])
      // The turn ended without a result: the task is lost, and the parent hears of it.
      const lost = yield* h.tasks.status(h.parent, task.taskId)
      expect([lost.status, Option.map(lost.failure, (failure) => failure.code)]).toEqual(["interrupted", Option.some("task.lost")])
    }).pipe(Effect.provide(capture)))
  })
})

describe("recovery", () => {
  test("reconcile runs a task whose runner never ran it, and delivers a result a runner closed but never delivered", () => scenario(Effect.gen(function* () {
    const h = yield* harness()
    yield* Ref.set(h.dropping, true)
    const never = yield* h.tasks.start(h.parent, { instructions: "never ran", mode: "spawn" })
    expect(never.status).toBe("pending")
    yield* Ref.set(h.dropping, false)
    expect(yield* h.tasks.reconcile(h.parent)).toEqual({ delivered: 0, started: 1 })
    yield* h.idle
    expect((yield* h.tasks.status(h.parent, never.taskId)).status).toBe("completed")
    expect((yield* h.reactions).length).toBe(1)

    yield* Ref.set(h.dropping, true)
    const lost = yield* h.tasks.start(h.parent, { instructions: "closed then lost", mode: "spawn" })
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* h.sessions.begin({ id: lost.child, owner }, say("closed then lost", `task:${lost.taskId}`))
      yield* writer.append([{ kind: "task.result", data: { taskId: lost.taskId, outcome: "partial", reply: "half of it", failure: null } }])
      yield* writer.end({ reason: "partial", failure: Option.none() })
    }))
    const closed = yield* h.tasks.status(h.parent, lost.taskId)
    expect([closed.status, closed.delivered]).toEqual(["partial", false])
    expect(yield* h.tasks.reconcile(h.parent)).toEqual({ delivered: 1, started: 0 })
    expect(yield* h.tasks.reconcile(h.parent)).toEqual({ delivered: 0, started: 0 })
    yield* h.drain(h.parent)
    expect((yield* h.reactions).at(-1)).toBe(`[Background task ${lost.taskId} stopped before it finished]\n<task-output>\nhalf of it\n</task-output>`)
  })))

  test("a task whose turn was abandoned is delivered as interrupted", () => scenario(Effect.gen(function* () {
    const h = yield* harness()
    yield* Ref.set(h.dropping, true)
    const stuck = yield* h.tasks.start(h.parent, { instructions: "abandoned", mode: "spawn" })
    const open = yield* Scope.make()
    yield* h.sessions.begin({ id: stuck.child, owner }, say("abandoned", `task:${stuck.taskId}`)).pipe(Scope.provide(open))
    expect((yield* h.tasks.status(h.parent, stuck.taskId)).status).toBe("running")
    yield* TestClock.adjust("2 minutes")
    const lost = yield* h.tasks.status(h.parent, stuck.taskId)
    expect([lost.status, Option.map(lost.failure, (failure) => failure.code)]).toEqual(["interrupted", Option.some("task.lost")])
    expect(yield* h.tasks.reconcile(h.parent)).toEqual({ delivered: 1, started: 0 })
    yield* h.drain(h.parent)
    expect((yield* h.reactions).at(-1)).toBe(`[Background task ${stuck.taskId} was interrupted]\n<task-output>\n(no reply: the task's turn stopped without a result)\n</task-output>`)
    yield* Scope.close(open, Exit.void)
  })))

  test("a child with no task.started in its parent never runs", () => scenario(Effect.gen(function* () {
    const h = yield* harness()
    const orphan = yield* h.sessions.fork(h.parent, { origin: "task", inherit: false })
    expect(yield* h.tasks.reconcile(h.parent)).toEqual({ delivered: 0, started: 0 })
    yield* h.idle
    expect((yield* h.sessions.get({ id: orphan.header.id, owner })).turns).toBe(0)
    expect(yield* h.tasks.list(h.parent)).toEqual([])
  })))
})

describe("cancel and removal", () => {
  test("a running task is cancelled at once and delivers nothing; a completed one cannot be cancelled", () => scenario(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const h = yield* harness({ turn: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) })
    const task = yield* h.tasks.start(h.parent, { instructions: "forever", mode: "spawn" })
    yield* Deferred.await(entered)
    expect((yield* h.tasks.status(h.parent, task.taskId)).status).toBe("running")
    expect(yield* h.tasks.cancel(h.parent, task.taskId)).toBe(true)
    yield* h.idle
    const cancelled = yield* h.tasks.status(h.parent, task.taskId)
    expect([cancelled.status, cancelled.delivered]).toEqual(["cancelled", false])
    expect(yield* h.reactions).toEqual([])
    expect(yield* h.kinds({ id: task.child, owner })).toEqual(["turn.started@1", "task.cancelled", "turn.ended@1"])
    expect(yield* h.kinds(h.parent)).toEqual(["task.started", "task.cancelled"])
    expect(yield* h.tasks.cancel(h.parent, task.taskId)).toBe(false)

    const quick = yield* harness()
    const done = yield* quick.tasks.start(quick.parent, { instructions: "quick", mode: "spawn" })
    yield* quick.idle
    expect(yield* quick.tasks.cancel(quick.parent, done.taskId)).toBe(false)
    expect((yield* quick.tasks.status(quick.parent, done.taskId)).status).toBe("completed")
    expect((yield* Effect.flip(quick.tasks.cancel(quick.parent, NO_TASK)))._tag).toBe("TaskMissing")
  })))

  test("a task whose turn is cancelled under it is logged as stopped, with how its turn was closed, not as a failure", () => {
    const { logged, layer: capture } = capturing()
    return scenario(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const h = yield* harness({ turn: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) })
      const task = yield* h.tasks.start(h.parent, { instructions: "forever", mode: "spawn" })
      yield* Deferred.await(entered)
      expect(yield* h.tasks.cancel(h.parent, task.taskId)).toBe(true)
      yield* h.idle
      expect(logged).toContainEqual(["Info", "the background task stopped: its turn was cancelled", h.parent.id, task.taskId])
      expect(logged.filter(([level]) => level === "Warn")).toEqual([])
    }).pipe(Effect.provide(capture)))
  })

  test("removing the parent removes its tasks, and a removed parent starts none", () => scenario(Effect.gen(function* () {
    const h = yield* harness()
    yield* Ref.set(h.dropping, true)
    const task = yield* h.tasks.start(h.parent, { instructions: "left behind", mode: "fork" })
    yield* h.sessions.remove(h.parent)
    expect((yield* Effect.flip(h.sessions.get({ id: task.child, owner })))._tag).toBe("SessionMissing")
    expect((yield* Effect.flip(h.tasks.start(h.parent, { instructions: "too late", mode: "spawn" })))._tag).toBe("SessionMissing")
  })))
})

describe("limits, failures and budgets", () => {
  test("a task does not start tasks, a host's fork of the conversation may, and a session runs so many at once", () => scenario(Effect.gen(function* () {
    const h = yield* harness({ turn: () => Effect.never })
    const first = yield* h.tasks.start(h.parent, { instructions: "one", mode: "fork" })
    yield* h.tasks.start(h.parent, { instructions: "two", mode: "fork" })
    const third = yield* Effect.flip(h.tasks.start(h.parent, { instructions: "three", mode: "fork" }))
    // The message is what start_task returns to the model.
    expect([third._tag, third._tag === "TaskRefused" ? [third.reason, third.message] : null]).toEqual([
      "TaskRefused", ["limit", "2 background tasks are already running; wait for one to finish"],
    ])
    const nested = yield* Effect.flip(h.tasks.start({ id: first.child, owner }, { instructions: "deeper", mode: "spawn" }))
    expect([nested._tag, nested._tag === "TaskRefused" ? [nested.reason, nested.message] : null]).toEqual([
      "TaskRefused", ["depth", "a background task cannot start another task"],
    ])
    const fork = yield* h.sessions.fork(h.parent, { origin: "user", inherit: true })
    const forked = yield* h.tasks.start({ id: fork.header.id, owner }, { instructions: "from the fork", mode: "spawn" })
    expect([forked.parent, forked.status]).toEqual([fork.header.id, "running"])
    expect(yield* h.tasks.cancel(h.parent, first.taskId)).toBe(true)
    yield* h.tasks.start(h.parent, { instructions: "three, now", mode: "fork" })
    expect((yield* h.tasks.list(h.parent)).map((task) => task.status).sort()).toEqual(["cancelled", "running", "running"])
  })))

  test("a failed task tells the parent why", () => scenario(Effect.gen(function* () {
    const h = yield* harness({ turn: () => Effect.fail(new HarnessError({ code: "model.down", message: "the model is unavailable" })) })
    const task = yield* h.tasks.start(h.parent, { instructions: "doomed", mode: "spawn" })
    yield* h.idle
    const failed = yield* h.tasks.status(h.parent, task.taskId)
    expect([failed.status, Option.map(failed.failure, (failure) => failure.code)]).toEqual(["failed", Option.some("model.down")])
    expect(yield* h.reactions).toEqual([`[Background task ${task.taskId} failed]\n<task-output>\n(no reply: the model is unavailable)\n</task-output>`])
    const child = yield* h.sessions.read({ id: task.child, owner }, { kinds: ["turn.ended"] })
    expect(child.map((event) => event.data.reason)).toEqual(["failed"])
  })))

  test("a task whose turn fails with one of the writer's tags stores the code it stands for, as the HarnessError of that code did", () => scenario(Effect.gen(function* () {
    const session = ConversationId.make("00000000-0000-4000-8000-0000000000c1")
    const failures: ReadonlyArray<TurnError> = [
      new SessionContended({ session, attempts: 3 }),
      new ReservedKind({ kind: "turn.ended" }),
      new SessionLogError({ code: "store.io", message: "the store is down" }),
      new HarnessError({ code: "session.contended", message: "turn 1: 3 conflicting writes" }),
    ]
    const stored = yield* Effect.forEach(failures, (error) => Effect.gen(function* () {
      const h = yield* harness({ turn: () => Effect.fail(error) })
      const task = yield* h.tasks.start(h.parent, { instructions: "refused", mode: "spawn" })
      yield* h.idle
      const status = yield* h.tasks.status(h.parent, task.taskId)
      return [status.status, Option.getOrNull(Option.map(status.failure, (failure) => failure.code))]
    }), { concurrency: 1 })
    expect(stored).toEqual([["failed", "session.contended"], ["failed", "events.reserved"], ["failed", "session.log"], ["failed", "session.contended"]])
  })))

  test("a task refused because the process is shutting down waits, its child untouched, and the next reconcile runs it", () => scenario(Effect.gen(function* () {
    const stopping = yield* Ref.make(true)
    const admission = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (turn, open) => Effect.gen(function* () {
        if ((yield* Ref.get(stopping)) && turn.key.startsWith("task:")) return yield* Effect.fail(shutdownRefusal(turn.session.id))
        return yield* open
      }),
    }))
    const h = yield* harness({ admission })
    const task = yield* h.tasks.start(h.parent, { instructions: "after the restart", mode: "spawn" })
    yield* h.idle
    const waiting = yield* h.tasks.status(h.parent, task.taskId)
    expect([waiting.status, Option.isNone(waiting.failure)]).toEqual(["pending", true])
    expect(yield* h.kinds({ id: task.child, owner })).toEqual([])
    // The restarted process admits it: its reconcile runs the task.
    yield* Ref.set(stopping, false)
    expect((yield* h.tasks.reconcile(h.parent)).started).toBe(1)
    yield* h.idle
    expect((yield* h.tasks.status(h.parent, task.taskId)).status).toBe("completed")
  })))

  test("a task the host will not admit fails with the host's reason, and the parent still hears of it", () => scenario(Effect.gen(function* () {
    const admission = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (turn, open) => turn.key.startsWith("task:")
        ? Effect.fail(new TurnRefused({ session: turn.session.id, reason: "budget", message: "no turns left today" }))
        : open,
    }))
    const h = yield* harness({ admission })
    const task = yield* h.tasks.start(h.parent, { instructions: "over budget", mode: "spawn" })
    yield* h.idle
    const refused = yield* h.tasks.status(h.parent, task.taskId)
    expect([refused.status, Option.map(refused.failure, (failure) => failure.code)]).toEqual(["failed", Option.some("task.refused")])
    expect(yield* h.kinds({ id: task.child, owner })).toEqual(["task.result"])
    expect(yield* h.reactions).toEqual([`[Background task ${task.taskId} failed]\n<task-output>\n(no reply: no turns left today)\n</task-output>`])
  })))

  test("a task past its execution cutoff ends interrupted, and with no time left to react its notice waits for the parent", () => scenario(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const h = yield* harness({ maxMs: 1_000, turn: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) })
    const task = yield* h.tasks.start(h.parent, { instructions: "slow", mode: "spawn" })
    yield* Deferred.await(entered)
    // The closing reserve is at most half the budget: execution stops at 500 ms.
    yield* TestClock.adjust("499 millis")
    expect((yield* h.tasks.status(h.parent, task.taskId)).status).toBe("running")
    yield* TestClock.adjust("1 millis")
    yield* h.idle
    const late = yield* h.tasks.status(h.parent, task.taskId)
    expect([late.status, Option.map(late.failure, (failure) => failure.code), late.delivered]).toEqual(["interrupted", Option.some("task.deadline"), true])
    const child = yield* h.sessions.read({ id: task.child, owner }, { kinds: ["turn.ended"] })
    expect(child.map((event) => event.data.reason)).toEqual(["interrupted"])
    expect([yield* h.kinds(h.parent), (yield* h.sessions.get(h.parent)).pending, yield* h.reactions]).toEqual([["task.started", "inbox.queued"], 1, []])
    expect(yield* h.tasks.reconcile(h.parent)).toEqual({ delivered: 0, started: 0 })
    expect((yield* h.drain(h.parent)).turns).toBe(1)
    expect((yield* h.reactions).length).toBe(1)
  })))

  test("execution leaves the configured closing reserve of the runner's budget", () => scenario(Effect.gen(function* () {
    const cutAfter = (config: Partial<TasksConfig>) => Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const h = yield* harness({ maxMs: 10_000, config, turn: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) })
      const task = yield* h.tasks.start(h.parent, { instructions: "slow", mode: "spawn" })
      yield* Deferred.await(entered)
      const reserve = config.closingReserveMs ?? tasksDefaults.closingReserveMs
      yield* TestClock.adjust(`${10_000 - reserve - 1} millis`)
      const before = (yield* h.tasks.status(h.parent, task.taskId)).status
      yield* TestClock.adjust("1 millis")
      yield* h.idle
      return [before, (yield* h.tasks.status(h.parent, task.taskId)).status]
    })
    expect(yield* cutAfter({})).toEqual(["running", "interrupted"])
    expect(yield* cutAfter({ closingReserveMs: 500 })).toEqual(["running", "interrupted"])
  })))

  test("the runner's deadline interrupts the parent's reaction and stores its ending; the notice waits for another", () => scenario(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const stopped = yield* Ref.make(false)
    const h = yield* harness({ maxMs: 1_000, react: () => Deferred.succeed(entered, undefined).pipe(
      Effect.andThen(Effect.never), Effect.ensuring(Ref.set(stopped, true)),
    ) })
    const task = yield* h.tasks.start(h.parent, { instructions: "quick child, slow parent", mode: "spawn" })
    yield* Deferred.await(entered)
    yield* TestClock.adjust("500 millis")
    yield* h.idle
    expect(yield* Ref.get(stopped)).toBe(true)
    expect((yield* h.tasks.status(h.parent, task.taskId)).status).toBe("completed")
    expect(Option.isNone((yield* h.sessions.get(h.parent)).open)).toBe(true)
    expect((yield* h.sessions.read(h.parent, { kinds: ["turn.ended"] })).map((event) => [event.data.reason, event.data.failure])).toEqual([
      ["interrupted", { code: "task.deadline", message: "the runner's deadline ended the inbox reaction" }],
    ])
    expect((yield* h.sessions.get(h.parent)).pending).toBe(1)
  })))

  test("a reaction cut after it recorded its answer is done: the parent does not answer twice", () => scenario(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    // The reaction stands in for the turn: memory records its answer as the framework's `turn.reply`.
    const h = yield* harness({ maxMs: 1_000, react: (writer) => writer.append([frameworkDraft("turn.reply", { body: { outcome: "completed", reply: "noted" } })]).pipe(
      Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never),
    ) })
    yield* h.tasks.start(h.parent, { instructions: "answered, then cut", mode: "spawn" })
    yield* Deferred.await(entered)
    yield* TestClock.adjust("500 millis")
    yield* h.idle
    expect((yield* h.sessions.read(h.parent, { kinds: ["turn.ended"] })).map((event) => event.data.reason)).toEqual(["partial"])
    expect((yield* h.sessions.get(h.parent)).pending).toBe(0)
    expect((yield* h.drain(h.parent)).turns).toBe(0)
    expect((yield* h.reactions).length).toBe(1)
  })))

  test("a reaction cut after it held its answer for the turn's end is done too: the end stores the answer, partial, in its own commit", () => scenario(Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    // As memory holds a turn's reply: for the closing commit, stored only with the end.
    const h = yield* harness({ maxMs: 1_000, react: (writer) => writer.closing([frameworkDraft("turn.reply", { body: { outcome: "completed", reply: "noted" } })]).pipe(
      Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never),
    ) })
    yield* h.tasks.start(h.parent, { instructions: "answered and held, then cut", mode: "spawn" })
    yield* Deferred.await(entered)
    yield* TestClock.adjust("500 millis")
    yield* h.idle
    const closed = (yield* h.sessions.read(h.parent, { kinds: ["turn.reply", "turn.ended"] })).map((event) => [event.seq, event.kind, event.data.reason ?? null] as const)
    expect(closed.map(([, kind, reason]) => [kind, reason])).toEqual([["turn.reply", null], ["turn.ended", "partial"]])
    expect(closed[1]![0]).toBe(closed[0]![0] + 1)
    expect((yield* h.sessions.get(h.parent)).pending).toBe(0)
    expect((yield* h.drain(h.parent)).turns).toBe(0)
  })))

  test("a parent admission that returns past the cutoff releases its turn: the notices wait with no attempt used", () => scenario(Effect.gen(function* () {
    const admitting = yield* Queue.unbounded<void>()
    const admission = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (turn, open) => turn.key.startsWith("task:") ? open
        : open.pipe(Effect.tap(() => Queue.offer(admitting, undefined)), Effect.tap(() => Effect.sleep("600 millis"))),
    }))
    const h = yield* harness({ maxMs: 1_000, admission })
    const late = Effect.gen(function* () {
      yield* h.tasks.start(h.parent, { instructions: "admitted late", mode: "spawn" })
      yield* Queue.take(admitting)
      yield* TestClock.adjust("600 millis")
      yield* h.idle
    })
    yield* late
    yield* late
    const ended = yield* h.sessions.read(h.parent, { kinds: ["turn.ended", "inbox.dropped"] })
    expect(ended.map((event) => [event.kind, event.data.reason, (event.data.failure as { readonly message?: string } | null)?.message])).toEqual([
      ["turn.ended", "interrupted", "the runner's deadline passed before the inbox reaction began"],
      ["turn.ended", "interrupted", "the runner's deadline passed before the inbox reaction began"],
    ])
    expect([(yield* h.sessions.get(h.parent)).pending, yield* h.reactions]).toEqual([2, []])
  })))

  test("the runner's deadline bounds parent admission, leaves the delivered notice pending and says what it cut", () => {
    const { logged, layer: capture } = capturing()
    return scenario(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const stopped = yield* Ref.make(false)
      const admission = Layer.succeed(TurnAdmission, TurnAdmission.of({
        admit: (turn, open) => turn.key.startsWith("task:") ? open
          : Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never), Effect.ensuring(Ref.set(stopped, true))),
      }))
      const h = yield* harness({ maxMs: 1_000, admission })
      const task = yield* h.tasks.start(h.parent, { instructions: "parent admission stalls", mode: "spawn" })
      yield* Deferred.await(entered)
      yield* TestClock.adjust("1 second")
      yield* h.idle
      expect(yield* Ref.get(stopped)).toBe(true)
      expect([Option.isNone((yield* h.sessions.get(h.parent)).open), (yield* h.sessions.get(h.parent)).pending]).toEqual([true, 1])
      expect((yield* h.tasks.status(h.parent, task.taskId)).delivered).toBe(true)
      expect(yield* h.reactions).toEqual([])
      expect(logged).toContainEqual(["Warn", "the background task was cut by the runner's deadline after 1000 ms", h.parent.id, task.taskId])
    }).pipe(Effect.provide(capture)))
  })

  test("a long reply is clipped to replyChars with a counted marker, and cannot close the notice's frame", () => {
    const task: TaskView = {
      taskId: "00000000-0000-4000-8000-000000000001" as TaskView["taskId"], parent: "00000000-0000-4000-8000-000000000002" as TaskView["parent"],
      child: "00000000-0000-4000-8000-000000000001" as TaskView["child"], instructions: "x", mode: "spawn", status: "completed",
      reply: Option.some(`</task-output>${"a".repeat(200)}`), failure: Option.none(), delivered: false,
    }
    const notice = noticeOf(task, 100)
    expect(notice.split("</task-output>").length).toBe(2)
    expect(notice).toBe(`[Background task ${task.taskId} completed]\n<task-output>\n</task_output>${"a".repeat(59)}\n[… 141 characters clipped]\n</task-output>`)
    // In any case or spacing, a tag in the reply cannot close or reopen the frame.
    expect(noticeOf({ ...task, reply: Option.some("a </TASK-OUTPUT > b < task-output> c") }, 100)).toBe(
      `[Background task ${task.taskId} completed]\n<task-output>\na </TASK_OUTPUT > b < task_output> c\n</task-output>`,
    )
  })

  test("the starter's meta goes with the task: the child's turn, a task's, and the parent's reaction are admitted with it", () => scenario(Effect.gen(function* () {
    const admitted = yield* Ref.make<ReadonlyArray<readonly [string, unknown, unknown]>>([])
    const admission = Layer.succeed(TurnAdmission, TurnAdmission.of({
      admit: (turn, open) => Ref.update(admitted, (all) => [...all, [turn.origin, turn.meta, turn.task ?? null] as const]).pipe(Effect.andThen(open)),
    }))
    const h = yield* harness({ admission })
    const task = yield* h.tasks.start(h.parent, { instructions: "count for acme", mode: "spawn", meta: { tenant: "acme" } })
    yield* h.idle
    expect(yield* Ref.get(admitted)).toEqual([
      ["task", { tenant: "acme" }, { taskId: task.taskId, parent: h.parent.id }],
      ["inbox", { tenant: "acme" }, null],
    ])
  })))

  test("the child's turn is a task's: origin task, its task's ref, the instructions its message and no command, stored so", () => scenario(Effect.gen(function* () {
    const turns = yield* Ref.make<ReadonlyArray<unknown>>([])
    const h = yield* harness({
      turn: (writer, task) => Ref.update(turns, (all) => [...all, {
        origin: writer.admitted.origin, task: writer.admitted.task, text: writer.admitted.userMessage.text, command: writer.admitted.command, key: writer.admitted.key,
      }]).pipe(Effect.as({ outcome: "completed" as const, reply: Option.some(`found: ${task.instructions}`) })),
    })
    const task = yield* h.tasks.start(h.parent, { instructions: "look it up", mode: "spawn" })
    yield* h.idle
    const ref = { taskId: task.taskId, parent: h.parent.id }
    expect(yield* Ref.get(turns)).toEqual([{ origin: "task", task: ref, text: "look it up", command: {}, key: `task:${task.taskId}` }])
    const [started] = yield* h.sessions.read({ id: task.child, owner }, { kinds: ["turn.started"] })
    expect([started?.data.origin, started?.data.task, started?.data.command]).toEqual(["task", ref, {}])
    // Its session is titled by the instructions, as by a user's first message.
    expect(Option.getOrNull((yield* h.sessions.get({ id: task.child, owner })).title)).toBe("look it up")
    // A task's turn cannot be resumed: it is no user's turn.
    const resumed = yield* Effect.flip(Effect.scoped(h.sessions.begin({ id: task.child, owner }, { _tag: "User", userMessage: new UserMessage({ text: "again" }), runId: RunId.make("run-resume"), key: "resume", command: {}, resumes: 1 })))
    expect([resumed._tag, resumed._tag === "NotResumable" ? resumed.reason : null]).toEqual(["NotResumable", "task"])
  })))

  test("task.started records the turn that started the task when it is given, and nothing for it otherwise", () => scenario(Effect.gen(function* () {
    const h = yield* harness()
    yield* h.tasks.start(h.parent, { instructions: "by a run", mode: "spawn", meta: { tenant: "acme" }, startedBy: { runId: RunId.make("run-7"), turn: 3 } })
    yield* h.tasks.start(h.parent, { instructions: "by the host", mode: "spawn" })
    yield* h.idle
    const started = yield* h.sessions.read(h.parent, { kinds: ["task.started"] })
    expect(started.map((event) => [event.data.meta, event.data.startedBy ?? null])).toEqual([[{ tenant: "acme" }, { runId: "run-7", turn: 3 }], [{}, null]])
  })))
})

describe("spans and logs", () => {
  test("each method is a tasks.<op> span with the parent's id, and the task's when it names one; a task's work is task.run with both", () => {
    const spans: Array<Tracer.NativeSpan> = []
    const tracer = Tracer.make({ span: (options) => { const span = new Tracer.NativeSpan(options); spans.push(span); return span } })
    return scenario(Effect.gen(function* () {
      const h = yield* harness()
      const task = yield* h.tasks.start(h.parent, { instructions: "traced", mode: "spawn" })
      yield* h.idle
      yield* h.tasks.status(h.parent, task.taskId)
      yield* h.tasks.list(h.parent)
      yield* h.tasks.cancel(h.parent, task.taskId)
      yield* h.tasks.reconcile(h.parent)
      expect((yield* Effect.flip(h.tasks.status(h.parent, NO_TASK)))._tag).toBe("TaskMissing")
      const ids = (span: Tracer.NativeSpan) => [span.attributes.get("efferent.session.id"), span.attributes.get("efferent.task.id")]
      const ended = (span: Tracer.NativeSpan) => span.status._tag === "Ended" ? span.status.exit._tag : "open"
      expect(spans.filter((span) => span.name.startsWith("task")).map((span) => [span.name, ...ids(span), ended(span)])).toEqual([
        ["tasks.start", h.parent.id, task.taskId, "Success"],
        ["task.run", h.parent.id, task.taskId, "Success"],
        ["tasks.status", h.parent.id, task.taskId, "Success"],
        ["tasks.list", h.parent.id, undefined, "Success"],
        ["tasks.cancel", h.parent.id, task.taskId, "Success"],
        ["tasks.reconcile", h.parent.id, undefined, "Success"],
        ["tasks.status", h.parent.id, NO_TASK, "Failure"],
      ])
    }).pipe(Effect.withTracer(tracer)))
  })

  test("a notice the parent's full inbox refuses is logged with the task's ids, and left for a later reconcile", () => {
    const { logged, layer: capture } = capturing()
    return scenario(Effect.gen(function* () {
      const h = yield* harness()
      const open = yield* Scope.make()
      yield* h.sessions.begin(h.parent, say("busy")).pipe(Scope.provide(open))
      yield* Effect.forEach(Array.from({ length: sessionsDefaults.inbox.maxPending }, (_, index) => InboxItemId.make(`note-${index}`)), (id) =>
        h.sessions.deliver(h.parent, { id, source: { kind: "host" }, content: "a note" }), { concurrency: 1, discard: true })
      const task = yield* h.tasks.start(h.parent, { instructions: "into a full inbox", mode: "spawn" })
      yield* h.idle
      expect(logged).toContainEqual(["Warn", "the parent's inbox is full; the task's notice is delivered later", h.parent.id, task.taskId])
      const done = yield* h.tasks.status(h.parent, task.taskId)
      expect([done.status, done.delivered]).toEqual(["completed", false])
      yield* Scope.close(open, Exit.void)
    }).pipe(Effect.provide(capture)))
  })
})


describe("helper execution controls", () => {
  const question = (writer: TurnWriter, id = "which-source") => ({ questionId: TaskQuestionId.make(id), text: "Which source?", askedBy: { run: { id: writer.admitted.runId, turn: writer.admitted.turn, ordinal: RunOrdinal.make(0) }, step: 0 } })

  test("a durable ask overrides a custom successful outcome and reply even after an early answer", () => scenario(Effect.gen(function* () {
    const h = yield* harness({ turn: (writer, task) => Tasks.pipe(Effect.flatMap((tasks) => Effect.gen(function* () {
      const asked = yield* tasks.ask(writer, question(writer)).pipe(Effect.orDie)
      yield* tasks.answer({ id: task.parent, owner }, task.taskId, { questionId: asked.questionId, text: "Primary source" }).pipe(Effect.orDie)
      return { outcome: "completed" as const, reply: Option.some("must not become a final result") }
    }))) })
    const started = yield* h.tasks.start(h.parent, { instructions: "ask", mode: "spawn" })
    yield* h.idle
    const child = { id: started.child, owner }
    const rows = yield* h.sessions.read(child)
    expect(rows.filter((row) => row.kind === "turn.ended").map((row) => row.data.reason)).toEqual(["waiting"])
    expect(rows.filter((row) => row.kind === "task.result")).toEqual([])
    expect((yield* h.sessions.get(child)).pending).toBe(1)
  })))

  test("an accepted answer replays its stored input across config changes and retires after cancellation", () => scenario(Effect.gen(function* () {
    const h = yield* harness({ turn: (writer) => Tasks.pipe(Effect.flatMap((tasks) => tasks.ask(writer, question(writer)).pipe(Effect.orDie)), Effect.as({ outcome: "waiting" as const, reply: Option.none() })) })
    const started = yield* h.tasks.start(h.parent, { instructions: "ask", mode: "spawn" })
    yield* h.idle
    const answer = { questionId: TaskQuestionId.make("which-source"), text: "a".repeat(300) }
    expect(yield* h.tasks.answer(h.parent, started.taskId, answer)).toEqual({ accepted: true, enqueued: true })
    const changed = yield* h.withConfig({ replyChars: 100 })
    expect(yield* changed.answer(h.parent, started.taskId, answer)).toEqual({ accepted: true, enqueued: false })
    const mismatch = yield* Effect.result(changed.answer(h.parent, started.taskId, { ...answer, text: "changed" }))
    expect(mismatch._tag === "Failure" ? mismatch.failure._tag : "accepted").toBe("TaskConflict")
    expect(yield* changed.cancel(h.parent, started.taskId)).toBe(true)
    expect(yield* changed.answer(h.parent, started.taskId, answer)).toEqual({ accepted: true, enqueued: false })
  })))

  test("a queued attempt's hard failure stays failed and its accepted question makes the fresh retry bookkeeping only", () => scenario(Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    const h = yield* harness({ turn: (writer) => Tasks.pipe(Effect.flatMap((tasks) => Effect.gen(function* () {
      const count = yield* Ref.updateAndGet(calls, (n) => n + 1)
      yield* tasks.ask(writer, question(writer, count === 1 ? "first" : "second")).pipe(Effect.orDie)
      if (count > 1) return yield* Effect.fail(new HarnessError({ code: "model.down", message: "the provider failed after the question" }))
      return { outcome: "waiting" as const, reply: Option.none() }
    }))) })
    const started = yield* h.tasks.start(h.parent, { instructions: "ask", mode: "spawn" })
    yield* h.idle
    const child = { id: started.child, owner }
    yield* h.tasks.answer(h.parent, started.taskId, { questionId: TaskQuestionId.make("first"), text: "continue" })
    yield* h.sessions.drain(child, (writer) => h.tasks.execute(writer).pipe(Effect.asVoid), { take: "inputs", maxTurns: 1 })
    expect((yield* h.sessions.read(child)).filter((row) => row.kind === "turn.ended").map((row) => row.data.reason)).toEqual(["waiting", "failed"])
    expect((yield* h.sessions.get(child)).pending).toBe(1)
    yield* h.tasks.reconcile(h.parent)
    yield* h.idle
    yield* h.sessions.drain(child, (writer) => h.tasks.execute(writer).pipe(Effect.flatMap((result) => writer.end({ reason: result.outcome, failure: Option.none() }))), { take: "inputs", maxTurns: 1 })
    expect(yield* Ref.get(calls)).toBe(2)
    expect((yield* h.tasks.status(h.parent, started.taskId)).question?.questionId).toBe(TaskQuestionId.make("second"))
    expect((yield* h.sessions.read(child)).filter((row) => row.kind === "task.result")).toEqual([])
  })))
  test("queued steering before the initial runner keeps its text and cannot skip the task instructions", () => scenario(Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<{ origin: string; message: string; history: ReadonlyArray<SessionLogEvent> }>>([])
    const h = yield* harness({ turn: (writer) => writer.history([]).pipe(Effect.flatMap((history) => Ref.update(seen, (all) => [...all, { origin: writer.admitted.origin, message: writer.admitted.userMessage.text, history }])), Effect.as({ outcome: "completed" as const, reply: Option.none() })) })
    yield* Ref.set(h.dropping, true)
    const task = yield* h.tasks.start(h.parent, { instructions: "Original task instructions", mode: "spawn" })
    const child = { id: task.child, owner }
    const id = InboxItemId.make("pending-steer")
    yield* h.tasks.steer(h.parent, task.taskId, { id, userMessage: new UserMessage({ text: "Inspect the primary source" }), source: {} })
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* h.sessions.begin(child, { _tag: "Queued", input: id, runId: RunId.make("before-initial") })
      const result = yield* h.tasks.execute(writer)
      expect(result).toEqual({ outcome: "waiting", reply: Option.none() })
      yield* writer.end({ reason: result.outcome, failure: Option.none() })
    }))
    expect(yield* Ref.get(seen)).toEqual([])
    expect((yield* h.tasks.status(h.parent, task.taskId)).status).toBe("pending")
    yield* Ref.set(h.dropping, false)
    yield* h.tasks.reconcile(h.parent)
    yield* h.idle
    const runs = yield* Ref.get(seen)
    expect(runs.map((run) => [run.origin, run.message])).toEqual([["task", "Original task instructions"]])
    expect(runs[0]?.history.filter((event) => event.kind === "turn.started").map((event) => event.data.userMessage)).toEqual([{ text: "Inspect the primary source" }])
  })))

  test("reconcile reactions use the pending question's starter metadata rather than an older finished task", () => scenario(Effect.gen(function* () {
    const metadata = yield* Ref.make<ReadonlyArray<JsonObject>>([])
    const h = yield* harness({
      turn: (writer, task) => task.instructions === "old task" ? Effect.succeed({ outcome: "completed", reply: Option.none() }) : Tasks.pipe(Effect.flatMap((tasks) => tasks.ask(writer, question(writer)).pipe(Effect.orDie)), Effect.as({ outcome: "waiting" as const, reply: Option.none() })),
      react: (writer) => Ref.update(metadata, (all) => [...all, writer.admitted.meta]),
    })
    yield* h.tasks.start(h.parent, { instructions: "old task", mode: "spawn", meta: { tenant: "old" } })
    yield* h.idle
    yield* Effect.scoped(Effect.gen(function* () {
      const writer = yield* h.sessions.begin(h.parent, say("hold parent"))
      yield* h.tasks.start(h.parent, { instructions: "new task", mode: "spawn", meta: { tenant: "new" } })
      yield* h.idle
      yield* writer.end(ended)
    }))
    yield* h.tasks.reconcile(h.parent, { react: true })
    yield* h.idle
    expect(yield* Ref.get(metadata)).toEqual([{ tenant: "old" }, { tenant: "new" }])
  })))

})
