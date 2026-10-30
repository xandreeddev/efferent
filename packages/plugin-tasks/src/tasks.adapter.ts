import { Cause, Clock, Effect, Layer, Option, Ref, Schema } from "effect"
import {
  ConversationId,
  isShutdownRefusal,
  MemoryKindOf,
  reasonOf,
  RunId,
  SessionExists,
  Sessions,
  TaskConflict,
  TaskExecutor,
  TaskMissing,
  TaskRefused,
  TaskRunner,
  Tasks,
  UserMessage,
} from "@xandreed/core"
import type { JsonObject, ReservedKind, SessionAddress, TaskMode, TaskView, TurnError, TurnOutcome, TurnRefused, TurnWriter } from "@xandreed/core"
import { deliveredOf, deliveryId, endOf, goneEnd, isActive, isChildOf, isFinished, isTaskSession, noticeOf, resultOf, startedOf } from "./task.entity.functions.js"
import { TASK_CANCELLED, TASK_RESULT, TASK_STARTED, TaskResult, TaskStarted } from "./task-records.entity.js"
import type { TaskResult as Result, TaskStarted as Started, TaskStarter, TasksConfig } from "./task-records.entity.js"

const OUTCOME_KINDS = [TASK_RESULT, TASK_CANCELLED]

/** The plugin's own records always encode: a failure to encode one is a defect. */
const startedJson = (started: Started) => Schema.encodeEffect(TaskStarted)(started).pipe(Effect.map((data): JsonObject => data), Effect.orDie)
const resultJson = (result: Result) => Schema.encodeEffect(TaskResult)(result).pipe(Effect.map((data): JsonObject => data), Effect.orDie)

/** Only the framework's kinds are reserved and the tasks plugin records its own: a refusal of one is a defect. */
const reservedIsDefect = (error: ReservedKind) => Effect.die(error)

/** The ids a session's task spans and logs carry: the parent session's. */
const sessionIds = (parent: SessionAddress): Record<string, unknown> => ({ "efferent.session.id": parent.id })

/** The ids one task's spans and logs carry: its parent session's and its own. */
const taskIds = (parent: SessionAddress, taskId: string): Record<string, unknown> => ({ ...sessionIds(parent), "efferent.task.id": taskId })

/** `effect` with `ids` on the current span and on its logs: in a `Tasks` method's `Effect.fn` pipeable, the current span is the method's. */
const carrying = <A, E, R>(effect: Effect.Effect<A, E, R>, ids: Record<string, unknown>): Effect.Effect<A, E, R> =>
  Effect.annotateCurrentSpan(ids).pipe(Effect.andThen(effect), Effect.annotateLogs(ids))

/**
 * Background tasks over Sessions. A task is one turn of a child session
 * whose id is the task's. Everything that decides reads the log (the
 * parent's `task.started`, the child's result or cancellation, the parent's
 * inbox), so any instance, or a later request, can finish what another
 * left: run a task that never ran, deliver a result that was never
 * delivered. Delivery is once per task (the inbox id), and whoever delivers
 * drains the parent, so it reacts after the answer in flight. The turns it
 * hands the executor (the child's, the parent's reactions) run with this
 * `Tasks` in context. Each method is
 * a `tasks.<op>` span and a task's work a `task.run` span; they and their
 * logs carry `efferent.session.id` (the parent's) and, for one task,
 * `efferent.task.id`.
 */
export const TasksLive = (config: TasksConfig): Layer.Layer<Tasks, never, Sessions | TaskRunner | TaskExecutor> => Layer.effect(Tasks, Effect.gen(function* () {
  const sessions = yield* Sessions
  const runner = yield* TaskRunner
  const executor = yield* TaskExecutor

  /**
   * The executor's turns, run with this `Tasks` in context (`service`, built
   * below): the work runs on the runner's fibers without its caller's
   * services, and a turn's `start_task` and `task_status` read it.
   */
  const withTasks = <A, E>(turn: Effect.Effect<A, E, Tasks>): Effect.Effect<A, E> => Effect.provideService(turn, Tasks, service)

  const childOf = (parent: SessionAddress, task: ConversationId): SessionAddress => ({ id: task, owner: parent.owner })

  /** The child's view and its records; a child that is gone, or a session under its id that is not the parent's task child, is none. */
  const childState = (parent: SessionAddress, child: SessionAddress) => sessions.get(child).pipe(
    Effect.flatMap((view) => isChildOf(view, parent.id)
      ? sessions.read(child, { kinds: OUTCOME_KINDS }).pipe(Effect.map((records) => Option.some([view, records] as const)))
      : Effect.succeed(Option.none())),
    Effect.catchTag("SessionMissing", () => Effect.succeed(Option.none())),
  )

  const viewOf = (parent: SessionAddress, started: Started, delivered: ReadonlySet<string>) => childState(parent, childOf(parent, started.taskId)).pipe(
    Effect.map((state): TaskView => ({
      taskId: started.taskId,
      parent: parent.id,
      child: started.taskId,
      instructions: started.instructions,
      mode: started.mode,
      ...Option.match(state, { onNone: () => goneEnd, onSome: ([view, records]) => endOf(view, records) }),
      delivered: delivered.has(deliveryId(started.taskId)),
    })),
  )

  const parentRecords = (parent: SessionAddress) => sessions.read(parent, { kinds: [TASK_STARTED, "inbox.queued"] })

  const listOf = (parent: SessionAddress) => parentRecords(parent).pipe(Effect.flatMap((events) => deliveredOf(events).pipe(Effect.flatMap((delivered) =>
    Effect.forEach(startedOf(events), (started) => viewOf(parent, started, delivered), { concurrency: 1 })))))

  /** The task as its parent started it, and where it stands. */
  const recordOf = (parent: SessionAddress, taskId: ConversationId) => Effect.gen(function* () {
    const events = yield* parentRecords(parent)
    const started = startedOf(events).find((record) => record.taskId === taskId)
    return started === undefined ? yield* Effect.fail(new TaskMissing({ session: parent.id, taskId }))
      : { started, task: yield* viewOf(parent, started, yield* deliveredOf(events)) }
  })

  const taskOf = (parent: SessionAddress, taskId: ConversationId) => recordOf(parent, taskId).pipe(Effect.map(({ task }) => task))

  /** The task's result in its child, recorded outside a turn (a child the host would not admit): unless it has ended. */
  const recordEnd = (child: SessionAddress, result: Result) => sessions.transact(child, () => Effect.gen(function* () {
    const records = yield* sessions.read(child, { kinds: OUTCOME_KINDS })
    return { drafts: records.length > 0 ? [] : [{ kind: TASK_RESULT, data: yield* resultJson(result) }], result: undefined }
  })).pipe(Effect.catchTag("ReservedKind", reservedIsDefect), Effect.asVoid)

  /** The turn's body until its deadline (then none) or until someone else closes the turn (then its `TurnClosed`). */
  const bounded = (body: Effect.Effect<TurnOutcome, TurnError>, writer: TurnWriter, deadline: Option.Option<number>) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const timed = Option.match(deadline, {
      onNone: () => body.pipe(Effect.map(Option.some)),
      onSome: (at) => body.pipe(Effect.timeoutOption(Math.max(0, at - now))),
    })
    return yield* Effect.raceFirst(timed, writer.closed.pipe(Effect.flatMap((closed) => Effect.fail(closed))))
  })

  /**
   * The child's one turn, a task's (origin `task`, its `TaskRef` the task's
   * and the parent's ids): begun once (its key is the task's) with the
   * starter's `meta`, its result recorded before it ends unless it was
   * cancelled. Once the turn is begun, a write the turn's writer refuses is
   * logged here: `TurnClosed` (the turn was closed under it: cancelled,
   * removed) as the task stopping, anything else (the result or the end not
   * stored) as a failure.
   */
  const runChild = (parent: SessionAddress, task: TaskView, meta: JsonObject, deadline: Option.Option<number>) => {
    const child = childOf(parent, task.child)
    return Effect.scoped(Effect.gen(function* () {
      const writer = yield* sessions.begin(child, {
        _tag: "Task", task: { taskId: task.taskId, parent: parent.id }, userMessage: new UserMessage({ text: task.instructions }),
        runId: RunId.make(yield* Effect.sync(() => crypto.randomUUID())), key: deliveryId(task.taskId), meta,
      })
      // A cancel that landed after the task was read, before its turn began.
      const cancelledFirst = (yield* sessions.read(child, { kinds: [TASK_CANCELLED] })).length > 0
      const turn = cancelledFirst ? writer.end({ reason: "cancelled", failure: Option.none() }) : Effect.gen(function* () {
        const exit = yield* Effect.exit(bounded(withTasks(executor.turn(writer, { ...task, status: "running" })), writer, deadline))
        const result = resultOf(task.taskId, exit)
        const data = yield* resultJson(result)
        yield* writer.transact((foreign) => Effect.succeed({
          drafts: foreign.some((event) => event.kind === TASK_CANCELLED) ? [] : [{ kind: TASK_RESULT, data }],
          result: undefined,
        }))
        return yield* writer.end({ reason: result.outcome, failure: result.failure })
      })
      return yield* turn.pipe(
        Effect.catchTag("TurnClosed", (closed) => Effect.logInfo(`the background task stopped: its turn was ${closed.reason}`).pipe(Effect.annotateLogs(taskIds(parent, task.taskId)))),
        Effect.catch((error) => Effect.logWarning(`the background task could not store its turn: ${reasonOf(Cause.fail(error))}`).pipe(Effect.annotateLogs(taskIds(parent, task.taskId)))),
      )
    })).pipe(
      Effect.catchTags({
        // Begun elsewhere, or before: that run records the result.
        SessionBusy: () => Effect.void,
        TurnDuplicate: () => Effect.void,
        KeyConflict: () => Effect.void,
        NothingPending: () => Effect.void,
        // A task's turn begins under a new run id: never raised here.
        RunIdReused: () => Effect.void,
        // A task's turn resumes nothing: never raised here.
        NotResumable: () => Effect.void,
        // Refused by a shutdown, the task waits: the next process's reconcile runs it.
        TurnRefused: (refused: TurnRefused) => isShutdownRefusal(refused)
          ? Effect.logInfo("the background task waits: the process is shutting down").pipe(Effect.annotateLogs(taskIds(parent, task.taskId)))
          : recordEnd(child, {
            taskId: task.taskId, outcome: "failed", reply: Option.none(), failure: Option.some({ code: "task.refused", message: refused.message }),
          }),
      }),
      Effect.asVoid,
    )
  }

  /** Put a finished task's notice in the parent's inbox; a full inbox is left for a later reconcile. */
  const deliverNotice = (parent: SessionAddress, task: TaskView) => sessions.deliver(parent, {
    id: deliveryId(task.taskId),
    source: { kind: "task", taskId: task.taskId, child: task.child, status: task.status },
    content: noticeOf(task, config.replyChars),
  }).pipe(Effect.catchTag("InboxFull", (full) =>
    Effect.logWarning("the parent's inbox is full; the task's notice is delivered later").pipe(
      Effect.annotateLogs(taskIds(parent, task.taskId)),
      Effect.as({ delivered: false, pending: full.pending }),
    )))

  /**
   * The writer, noting when the reaction records its answer (the turn's
   * `turn.reply`, as memory writes it: held for the turn's closing commit,
   * which the reaction's end then stores).
   */
  const noting = (writer: TurnWriter, answered: Ref.Ref<boolean>): TurnWriter => {
    const note = (drafts: ReadonlyArray<{ readonly kind: string }>) => drafts.some((draft) => draft.kind === MemoryKindOf.TurnEnded) ? Ref.set(answered, true) : Effect.void
    return {
      ...writer,
      append: (drafts) => note(drafts).pipe(Effect.andThen(writer.append(drafts))),
      transact: (decide) => writer.transact((foreign) => decide(foreign).pipe(Effect.tap((decision) => note(decision.drafts)))),
      closing: (drafts) => writer.closing(drafts).pipe(Effect.andThen(note(drafts))),
    }
  }

  /**
   * The parent's reaction to what waits, within the budget. A turn opened
   * too late to react is released: it ends interrupted having written
   * nothing, so its items wait again with no attempt counted. A reaction cut
   * by the deadline ends partial once it has recorded its answer (its items
   * are done: answering again would answer twice), interrupted otherwise.
   */
  const reaction = (writer: TurnWriter, deadline: Option.Option<number>) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    if (Option.isNone(deadline)) return yield* withTasks(executor.react(writer))
    const cut = { code: "task.deadline", message: "the runner's deadline ended the inbox reaction" }
    if (deadline.value <= now) {
      return yield* writer.end({ reason: "interrupted", failure: Option.some({ ...cut, message: "the runner's deadline passed before the inbox reaction began" }) })
    }
    const answered = yield* Ref.make(false)
    const reacted = yield* withTasks(executor.react(noting(writer, answered))).pipe(Effect.timeoutOption(deadline.value - now))
    if (Option.isSome(reacted)) return
    yield* writer.end({ reason: (yield* Ref.get(answered)) ? "partial" : "interrupted", failure: Option.some(cut) })
  })

  /** Deliver the task if it finished and was not delivered, then let the parent react to what waits, its turns begun with the starter's `meta`. */
  const settle = (parent: SessionAddress, taskId: ConversationId, meta: JsonObject, deadline: Option.Option<number>) => Effect.gen(function* () {
    const task = yield* taskOf(parent, taskId)
    if (!isFinished(task.status) || task.delivered) return
    const delivered = yield* deliverNotice(parent, task)
    const now = yield* Clock.currentTimeMillis
    const remaining = Option.map(deadline, (at) => at - now)
    if (delivered.pending === 0 || (Option.isSome(remaining) && remaining.value <= 0)) return
    yield* sessions.drain(parent, (writer) => reaction(writer, deadline), Option.isSome(deadline) ? { maxTurns: 1, meta } : { meta })
  })

  /**
   * The task's work within the runner's deadline: execution (the child's
   * turn, the parent's reaction) stops the closing reserve before it, so
   * what follows has time to be stored; the deadline itself cuts the rest,
   * with a warning of how long the work ran.
   */
  const work = (parent: SessionAddress, taskId: ConversationId) => (deadline: Option.Option<number>): Effect.Effect<void> => Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const executeBy = Option.map(deadline, (at) => at - Math.min(config.closingReserveMs, Math.floor(Math.max(0, at - started) / 2)))
    const execution = Effect.gen(function* () {
      const { started: record, task } = yield* recordOf(parent, taskId)
      if (task.status === "pending") yield* runChild(parent, task, record.meta, executeBy)
      yield* settle(parent, taskId, record.meta, executeBy)
    })
    yield* Option.match(deadline, {
      onNone: () => execution,
      onSome: (at) => execution.pipe(Effect.timeoutOption(Math.max(0, at - started)), Effect.flatMap(Option.match({
        onSome: () => Effect.void,
        onNone: () => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
          Effect.logWarning(`the background task was cut by the runner's deadline after ${now - started} ms`).pipe(Effect.annotateLogs(taskIds(parent, taskId))))),
      }))),
    })
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("the background task stopped", cause).pipe(Effect.annotateLogs(taskIds(parent, taskId)))),
    Effect.withSpan("task.run", { attributes: taskIds(parent, taskId) }),
  )

  /**
   * The task's child, created once its `task.started` is stored: a fork of the
   * parent (or an empty spawn) under the task's id. One that exists is kept
   * when it is the parent's task child (a retried start); any other session
   * under the id is `SessionExists`. True when it was created now.
   */
  const childFor = (parent: SessionAddress, started: Started) =>
    sessions.fork(parent, { id: started.taskId, origin: "task", meta: { taskId: started.taskId, mode: started.mode }, inherit: started.mode === "fork" }).pipe(
      Effect.as(true),
      Effect.catchTag("SessionExists", (exists) => sessions.get(childOf(parent, started.taskId)).pipe(
        Effect.catchTag("SessionMissing", () => Effect.fail(exists)),
        Effect.flatMap((view) => isChildOf(view, parent.id) ? Effect.succeed(false) : Effect.fail(exists)),
      )),
    )

  const start = (parent: SessionAddress, input: {
    readonly taskId?: ConversationId
    readonly instructions: string
    readonly mode: TaskMode
    readonly meta?: JsonObject
    readonly startedBy?: TaskStarter
  }) => Effect.gen(function* () {
    // A task's own session starts none; any other may, a host's fork of a conversation included.
    if (isTaskSession(yield* sessions.get(parent))) {
      return yield* Effect.fail(new TaskRefused({ session: parent.id, reason: "depth", message: "a background task cannot start another task" }))
    }
    const taskId = input.taskId ?? ConversationId.make(yield* Effect.sync(() => crypto.randomUUID()))
    yield* Effect.annotateCurrentSpan("efferent.task.id", taskId)
    const started: Started = {
      taskId, instructions: input.instructions, mode: input.mode, meta: input.meta ?? {},
      // Written only when given: a task a host started is stored as before.
      ...(input.startedBy === undefined ? {} : { startedBy: input.startedBy }),
    }
    // Checked against the tasks as stored, and decided again after a conflict, so the decision only reads: the
    // child is created after the record is stored, and the two are not cut apart by an interruption.
    const begun = yield* Effect.uninterruptible(sessions.transact(parent, () => Effect.gen(function* () {
      const earlier = startedOf(yield* parentRecords(parent)).find((record) => record.taskId === taskId)
      if (earlier !== undefined) {
        // A retry of the start is the same task; other instructions or another mode under its id are not.
        return earlier.instructions === input.instructions && earlier.mode === input.mode
          ? { drafts: [], result: false }
          : yield* Effect.fail(new TaskConflict({ session: parent.id, taskId }))
      }
      const active = (yield* listOf(parent)).filter((task) => isActive(task.status)).length
      if (active >= config.maxRunning) {
        return yield* Effect.fail(new TaskRefused({
          session: parent.id, reason: "limit", message: `${active} background tasks are already running; wait for one to finish`,
        }))
      }
      // The id may not name another session (the parent itself, another conversation): the child is created under it.
      const taken = yield* sessions.get(childOf(parent, taskId)).pipe(Effect.map(Option.some), Effect.catchTag("SessionMissing", () => Effect.succeedNone))
      if (Option.exists(taken, (session) => !isChildOf(session, parent.id))) return yield* Effect.fail(new SessionExists({ session: taskId }))
      return { drafts: [{ kind: TASK_STARTED, data: yield* startedJson(started) }], result: true }
    })).pipe(
      Effect.catchTag("ReservedKind", reservedIsDefect),
      // A retry also creates the child a start that stopped between the two left without one, and runs the task then.
      Effect.flatMap((decided) => childFor(parent, started).pipe(Effect.map((created) => decided.result || created))),
    ))
    if (begun) yield* runner.run(work(parent, taskId))
    // Its `task.started` is stored: a parent that does not show it is a store that lost a commit it confirmed.
    return yield* taskOf(parent, taskId).pipe(Effect.catchTag("TaskMissing", () =>
      Effect.die(new Error(`task ${taskId} was started but is not in ${parent.id}`))))
  })

  const cancel = (parent: SessionAddress, taskId: ConversationId) => Effect.gen(function* () {
    const task = yield* taskOf(parent, taskId)
    if (!isActive(task.status)) return false
    const child = childOf(parent, task.child)
    const decided = yield* sessions.transact(child, (view) => sessions.read(child, { kinds: OUTCOME_KINDS }).pipe(Effect.map((records) =>
      isActive(endOf(view, records).status)
        ? { drafts: [{ kind: TASK_CANCELLED, data: { taskId } }], result: { cancelled: true, open: Option.map(view.open, (open) => open.turn) } }
        : { drafts: [], result: { cancelled: false, open: Option.none<number>() } }))).pipe(Effect.catchTag("ReservedKind", reservedIsDefect))
    if (!decided.result.cancelled) return false
    yield* Option.match(decided.result.open, { onNone: () => Effect.void, onSome: (turn) => sessions.cancel(child, turn).pipe(Effect.asVoid) })
    yield* sessions.transact(parent, () => Effect.succeed({ drafts: [{ kind: TASK_CANCELLED, data: { taskId } }], result: undefined }))
      .pipe(Effect.catchTag("ReservedKind", reservedIsDefect))
    return true
  })

  const reconcile = (parent: SessionAddress) => Effect.gen(function* () {
    const tasks = yield* listOf(parent)
    const delivered = yield* Effect.forEach(tasks.filter((task) => isFinished(task.status) && !task.delivered), (task) => deliverNotice(parent, task), { concurrency: 1 })
    const waiting = tasks.filter((task) => task.status === "pending")
    yield* Effect.forEach(waiting, (task) => runner.run(work(parent, task.taskId)), { concurrency: 1, discard: true })
    return { delivered: delivered.filter((done) => done.delivered).length, started: waiting.length }
  })

  // The helpers the methods share stay untraced: a span is one call of the service.
  const service = Tasks.of({
    start: Effect.fn("tasks.start")(start, (effect, parent) => carrying(effect, sessionIds(parent))),
    status: Effect.fn("tasks.status")(taskOf, (effect, parent, taskId) => carrying(effect, taskIds(parent, taskId))),
    list: Effect.fn("tasks.list")(listOf, (effect, parent) => carrying(effect, sessionIds(parent))),
    cancel: Effect.fn("tasks.cancel")(cancel, (effect, parent, taskId) => carrying(effect, taskIds(parent, taskId))),
    reconcile: Effect.fn("tasks.reconcile")(reconcile, (effect, parent) => carrying(effect, sessionIds(parent))),
  })
  return service
}))
