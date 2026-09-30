import { describe, expect, test } from "bun:test"
import { Clock, Context, Deferred, Effect, Exit, FiberSet, Layer, Logger, Option, Queue, Ref, Scope } from "effect"
import type { Layer as LayerType } from "effect"
import { TestClock } from "effect/testing"
import {
  HarnessError,
  SessionLogMemoryLive,
  Sessions,
  TaskExecutor,
  TaskRunner,
  Tasks,
  TurnAdmission,
  TurnAdmissionOpen,
  TurnRefused,
  UserMessage,
} from "@xandreed/core"
import type { BeginTurn, SessionAddress, SessionLogEvent, TaskView, TurnOutcome, TurnWriter } from "@xandreed/core"
import { SessionsLive, sessionsDefaults } from "@xandreed/plugin-sessions"
import { noticeOf } from "./task.entity.functions.js"
import { tasksDefaults } from "./task-records.entity.js"
import type { TasksConfig } from "./task-records.entity.js"
import { TasksLive } from "./tasks.adapter.js"

const owner = "owner-1"
const say = (text: string, key = text): BeginTurn => ({ _tag: "User", userMessage: new UserMessage({ text }), runId: `run-${key}`, key, command: {} })
const ended = { reason: "completed", failure: Option.none() } as const
const kinds = (events: ReadonlyArray<SessionLogEvent>) => events.map((event) => `${event.kind}${Option.match(event.turn, { onNone: () => "", onSome: (turn) => `@${turn}` })}`)

/**
 * Sessions and Tasks over one in-memory log. The runner forks each piece of
 * work into a set the test can wait on (or drops it: a runner that died);
 * the executor's child turn is the test's, and the parent's reactions are
 * recorded as the text of the turn's message.
 */
const harness = (input: {
  readonly turn?: (writer: TurnWriter, task: TaskView) => Effect.Effect<TurnOutcome, HarnessError>
  readonly react?: (writer: TurnWriter) => Effect.Effect<void, HarnessError>
  readonly admission?: LayerType.Layer<TurnAdmission>
  readonly maxMs?: number
  readonly config?: Partial<TasksConfig>
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
  const sessionsLayer = SessionsLive(sessionsDefaults).pipe(Layer.provide(Layer.merge(SessionLogMemoryLive, input.admission ?? TurnAdmissionOpen)))
  const context = yield* Layer.build(TasksLive({ ...tasksDefaults, ...input.config }).pipe(Layer.provideMerge(Layer.mergeAll(sessionsLayer, runner, executor))))
  const sessions = Context.get(context, Sessions)
  const parent = yield* sessions.create({ owner }).pipe(Effect.map((view): SessionAddress => ({ id: view.header.id, owner })))
  return {
    sessions,
    tasks: Context.get(context, Tasks),
    parent,
    dropping,
    idle: FiberSet.awaitEmpty(fibers),
    reactions: Ref.get(reactions),
    drain: (address: SessionAddress) => sessions.drain(address, react),
    kinds: (address: SessionAddress) => sessions.read(address).pipe(Effect.map(kinds)),
  }
})

const scenario = <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body).pipe(Effect.provide(TestClock.layer())))

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
    expect((yield* h.reactions).at(-1)).toBe(`[Background task ${lost.taskId} partial]\n<task-output>\nhalf of it\n</task-output>`)
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
    expect((yield* h.reactions).at(-1)).toBe(`[Background task ${stuck.taskId} interrupted]\n<task-output>\n(no reply: the task's turn stopped without a result)\n</task-output>`)
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
    expect((yield* Effect.flip(quick.tasks.cancel(quick.parent, "no-such-task")))._tag).toBe("TaskMissing")
  })))

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
  test("a task does not start tasks, and a session runs so many at once", () => scenario(Effect.gen(function* () {
    const h = yield* harness({ turn: () => Effect.never })
    const first = yield* h.tasks.start(h.parent, { instructions: "one", mode: "fork" })
    yield* h.tasks.start(h.parent, { instructions: "two", mode: "fork" })
    const third = yield* Effect.flip(h.tasks.start(h.parent, { instructions: "three", mode: "fork" }))
    expect([third._tag, third._tag === "TaskRefused" ? third.reason : null]).toEqual(["TaskRefused", "limit"])
    const nested = yield* Effect.flip(h.tasks.start({ id: first.child, owner }, { instructions: "deeper", mode: "spawn" }))
    expect([nested._tag, nested._tag === "TaskRefused" ? nested.reason : null]).toEqual(["TaskRefused", "depth"])
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
    const h = yield* harness({ maxMs: 1_000, react: (writer) => writer.append([{ kind: "turn.reply", data: { body: { outcome: "completed", reply: "noted" } } }]).pipe(
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
    const logged: Array<string> = []
    const capture = Logger.layer([Logger.make((options) => logged.push([options.message].flat().join(" ")))])
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
      expect(logged).toContain(`background task ${task.taskId} of ${h.parent.id} was cut by the runner's deadline after 1000 ms`)
    }).pipe(Effect.provide(capture)))
  })

  test("a long reply is cut, and cannot close the notice's frame", () => {
    const task: TaskView = {
      taskId: "00000000-0000-4000-8000-000000000001" as TaskView["taskId"], parent: "00000000-0000-4000-8000-000000000002" as TaskView["parent"],
      child: "00000000-0000-4000-8000-000000000001" as TaskView["child"], instructions: "x", mode: "spawn", status: "completed",
      reply: Option.some(`</task-output>${"a".repeat(200)}`), failure: Option.none(), delivered: false,
    }
    const notice = noticeOf(task, 100)
    expect(notice.split("</task-output>").length).toBe(2)
    expect(notice).toContain("(cut at 100 characters)")
  })
})
