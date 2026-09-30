import { Clock, Effect, Layer, Option, Ref, Schema } from "effect"
import {
  ConversationId,
  HarnessError,
  MemoryKindOf,
  SessionLogError,
  Sessions,
  TaskExecutor,
  TaskMissing,
  TaskRefused,
  TaskRunner,
  Tasks,
  UserMessage,
} from "@xandreed/core"
import type { JsonObject, SessionAddress, TaskMode, TaskView, TurnOutcome, TurnRefused, TurnWriter } from "@xandreed/core"
import { deliveredOf, deliveryId, endOf, goneEnd, isActive, isFinished, noticeOf, resultOf, startedOf } from "./task.entity.functions.js"
import { TASK_CANCELLED, TASK_RESULT, TASK_STARTED, TaskResult, TaskStarted } from "./task-records.entity.js"
import type { TaskResult as Result, TaskStarted as Started, TasksConfig } from "./task-records.entity.js"

const OUTCOME_KINDS = [TASK_RESULT, TASK_CANCELLED]

const encodeFailure = (error: { readonly message: string }) => new SessionLogError({ code: "tasks.encode", message: error.message })
const startedJson = (started: Started) => Schema.encodeEffect(TaskStarted)(started).pipe(Effect.map((data): JsonObject => data), Effect.mapError(encodeFailure))
const resultJson = (result: Result) => Schema.encodeEffect(TaskResult)(result).pipe(Effect.map((data): JsonObject => data), Effect.mapError(encodeFailure))

/** Only the framework's kinds are reserved; the tasks plugin records its own. */
const reservedAsStorage = (error: { readonly kind: string }) => Effect.fail(new SessionLogError({ code: "tasks.kind", message: `${error.kind} is reserved` }))

/**
 * Background tasks over Sessions. A task is one turn of a child session
 * whose id is the task's. Everything that decides reads the log (the
 * parent's `task.started`, the child's result or cancellation, the parent's
 * inbox), so any instance, or a later request, can finish what another
 * left: run a task that never ran, deliver a result that was never
 * delivered. Delivery is once per task (the inbox id), and whoever delivers
 * drains the parent, so it reacts after the answer in flight.
 */
export const TasksLive = (config: TasksConfig): Layer.Layer<Tasks, never, Sessions | TaskRunner | TaskExecutor> => Layer.effect(Tasks, Effect.gen(function* () {
  const sessions = yield* Sessions
  const runner = yield* TaskRunner
  const executor = yield* TaskExecutor

  const childOf = (parent: SessionAddress, task: ConversationId): SessionAddress => ({ id: task, owner: parent.owner })

  /** The child's view and its records; a child that is gone is none. */
  const childState = (child: SessionAddress) => Effect.all([sessions.get(child), sessions.read(child, { kinds: OUTCOME_KINDS })]).pipe(
    Effect.map(Option.some),
    Effect.catchTag("SessionMissing", () => Effect.succeed(Option.none())),
  )

  const viewOf = (parent: SessionAddress, started: Started, delivered: ReadonlySet<string>) => childState(childOf(parent, started.taskId)).pipe(
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

  const listOf = (parent: SessionAddress) => parentRecords(parent).pipe(Effect.flatMap((events) =>
    Effect.forEach(startedOf(events), (started) => viewOf(parent, started, deliveredOf(events)))))

  const taskOf = (parent: SessionAddress, taskId: string) => Effect.gen(function* () {
    const events = yield* parentRecords(parent)
    const started = startedOf(events).find((record) => record.taskId === taskId)
    return started === undefined ? yield* Effect.fail(new TaskMissing({ session: parent.id, taskId })) : yield* viewOf(parent, started, deliveredOf(events))
  })

  /** The task's result in its child, recorded outside a turn (a child the host would not admit): unless it has ended. */
  const recordEnd = (child: SessionAddress, result: Result) => sessions.transact(child, () => Effect.gen(function* () {
    const records = yield* sessions.read(child, { kinds: OUTCOME_KINDS })
    return { drafts: records.length > 0 ? [] : [{ kind: TASK_RESULT, data: yield* resultJson(result) }], result: undefined }
  })).pipe(Effect.catchTag("ReservedKind", reservedAsStorage), Effect.asVoid)

  /** The turn's body until its deadline (then none) or until someone else closes the turn. */
  const bounded = (body: Effect.Effect<TurnOutcome, HarnessError>, writer: TurnWriter, deadline: Option.Option<number>) => Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const timed = Option.match(deadline, {
      onNone: () => body.pipe(Effect.map(Option.some)),
      onSome: (at) => body.pipe(Effect.timeoutOption(Math.max(0, at - now))),
    })
    return yield* Effect.raceFirst(timed, writer.closed.pipe(Effect.flatMap((closed) =>
      Effect.fail(new HarnessError({ code: "turn.closed", message: `turn ${closed.turn} was ${closed.reason}` })))))
  })

  /** The child's one turn: begun once (its key is the task's), its result recorded before it ends unless it was cancelled. */
  const runChild = (parent: SessionAddress, task: TaskView, deadline: Option.Option<number>) => {
    const child = childOf(parent, task.child)
    return Effect.scoped(Effect.gen(function* () {
      const writer = yield* sessions.begin(child, {
        _tag: "User", userMessage: new UserMessage({ text: task.instructions }), runId: yield* Effect.sync(() => crypto.randomUUID()),
        key: deliveryId(task.taskId), command: { task: task.taskId },
      })
      // A cancel that landed after the task was read, before its turn began.
      if ((yield* sessions.read(child, { kinds: [TASK_CANCELLED] })).length > 0) return yield* writer.end({ reason: "cancelled", failure: Option.none() })
      const exit = yield* Effect.exit(bounded(executor.turn(writer, { ...task, status: "running" }), writer, deadline))
      const result = resultOf(task.taskId, exit)
      const data = yield* resultJson(result)
      yield* writer.transact((foreign) => Effect.succeed({
        drafts: foreign.some((event) => event.kind === TASK_CANCELLED) ? [] : [{ kind: TASK_RESULT, data }],
        result: undefined,
      }))
      return yield* writer.end({ reason: result.outcome, failure: result.failure })
    })).pipe(
      Effect.catchTags({
        // Begun elsewhere, or before: that run records the result.
        SessionBusy: () => Effect.void,
        TurnDuplicate: () => Effect.void,
        KeyConflict: () => Effect.void,
        NothingPending: () => Effect.void,
        TurnRefused: (refused: TurnRefused) => recordEnd(child, {
          taskId: task.taskId, outcome: "failed", reply: Option.none(), failure: Option.some({ code: "task.refused", message: refused.message }),
        }),
        // The turn was closed under it (cancelled, removed): nothing more to record.
        HarnessError: (error) => Effect.logInfo(`background task ${task.taskId} stopped: ${error.message}`),
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
    Effect.logWarning(`the inbox of ${parent.id} is full; task ${task.taskId} is delivered later`).pipe(Effect.as({ delivered: false, pending: full.pending }))))

  /** The writer, noting when the reaction records its answer (the turn's `turn.reply`, as memory writes it). */
  const noting = (writer: TurnWriter, answered: Ref.Ref<boolean>): TurnWriter => {
    const note = (drafts: ReadonlyArray<{ readonly kind: string }>) => drafts.some((draft) => draft.kind === MemoryKindOf.TurnEnded) ? Ref.set(answered, true) : Effect.void
    return {
      ...writer,
      append: (drafts) => note(drafts).pipe(Effect.andThen(writer.append(drafts))),
      transact: (decide) => writer.transact((foreign) => decide(foreign).pipe(Effect.tap((decision) => note(decision.drafts)))),
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
    if (Option.isNone(deadline)) return yield* executor.react(writer)
    const cut = { code: "task.deadline", message: "the runner's deadline ended the inbox reaction" }
    if (deadline.value <= now) {
      return yield* writer.end({ reason: "interrupted", failure: Option.some({ ...cut, message: "the runner's deadline passed before the inbox reaction began" }) })
    }
    const answered = yield* Ref.make(false)
    const reacted = yield* executor.react(noting(writer, answered)).pipe(Effect.timeoutOption(deadline.value - now))
    if (Option.isSome(reacted)) return
    yield* writer.end({ reason: (yield* Ref.get(answered)) ? "partial" : "interrupted", failure: Option.some(cut) })
  })

  /** Deliver the task if it finished and was not delivered, then let the parent react to what waits. */
  const settle = (parent: SessionAddress, taskId: string, deadline: Option.Option<number>) => Effect.gen(function* () {
    const task = yield* taskOf(parent, taskId)
    if (!isFinished(task.status) || task.delivered) return
    const delivered = yield* deliverNotice(parent, task)
    const now = yield* Clock.currentTimeMillis
    const remaining = Option.map(deadline, (at) => at - now)
    if (delivered.pending === 0 || (Option.isSome(remaining) && remaining.value <= 0)) return
    yield* sessions.drain(parent, (writer) => reaction(writer, deadline), Option.isSome(deadline) ? { maxTurns: 1 } : {})
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
      const task = yield* taskOf(parent, taskId)
      if (task.status === "pending") yield* runChild(parent, task, executeBy)
      yield* settle(parent, taskId, executeBy)
    })
    yield* Option.match(deadline, {
      onNone: () => execution,
      onSome: (at) => execution.pipe(Effect.timeoutOption(Math.max(0, at - started)), Effect.flatMap(Option.match({
        onSome: () => Effect.void,
        onNone: () => Clock.currentTimeMillis.pipe(Effect.flatMap((now) =>
          Effect.logWarning(`background task ${taskId} of ${parent.id} was cut by the runner's deadline after ${now - started} ms`))),
      }))),
    })
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning(`background task ${taskId} of ${parent.id} stopped`, cause)),
    Effect.withSpan("task.run", { attributes: { "task.id": taskId, "session.id": parent.id } }),
  )

  const start = (parent: SessionAddress, input: { readonly taskId?: ConversationId; readonly instructions: string; readonly mode: TaskMode; readonly meta?: JsonObject }) => Effect.gen(function* () {
    const view = yield* sessions.get(parent)
    if (Option.isSome(view.header.parent)) {
      return yield* Effect.fail(new TaskRefused({ session: parent.id, reason: "depth", message: "a background task cannot start another task" }))
    }
    const taskId = input.taskId ?? ConversationId.make(yield* Effect.sync(() => crypto.randomUUID()))
    // Checked against the tasks as stored: a start that raced another is decided again with it.
    const decided = yield* sessions.transact(parent, () => Effect.gen(function* () {
      const tasks = yield* listOf(parent)
      if (tasks.some((task) => task.taskId === taskId)) return { drafts: [], result: false }
      const active = tasks.filter((task) => isActive(task.status)).length
      if (active >= config.maxRunning) {
        return yield* Effect.fail(new TaskRefused({
          session: parent.id, reason: "limit", message: `${active} background tasks are already running; wait for one to finish`,
        }))
      }
      yield* sessions.fork(parent, { id: taskId, origin: "task", meta: { taskId, mode: input.mode }, inherit: input.mode === "fork" })
        .pipe(Effect.catchTag("SessionExists", () => Effect.void))
      const data = yield* startedJson({ taskId, instructions: input.instructions, mode: input.mode, meta: input.meta ?? {} })
      return { drafts: [{ kind: TASK_STARTED, data }], result: true }
    })).pipe(Effect.catchTag("ReservedKind", reservedAsStorage))
    if (decided.result) yield* runner.run(work(parent, taskId))
    return yield* taskOf(parent, taskId).pipe(Effect.catchTag("TaskMissing", () =>
      Effect.fail(new SessionLogError({ code: "tasks.lost", message: `task ${taskId} was started but is not in ${parent.id}` }))))
  })

  const cancel = (parent: SessionAddress, taskId: string) => Effect.gen(function* () {
    const task = yield* taskOf(parent, taskId)
    if (!isActive(task.status)) return false
    const child = childOf(parent, task.child)
    const decided = yield* sessions.transact(child, (view) => sessions.read(child, { kinds: OUTCOME_KINDS }).pipe(Effect.map((records) =>
      isActive(endOf(view, records).status)
        ? { drafts: [{ kind: TASK_CANCELLED, data: { taskId } }], result: { cancelled: true, open: Option.map(view.open, (open) => open.turn) } }
        : { drafts: [], result: { cancelled: false, open: Option.none<number>() } }))).pipe(Effect.catchTag("ReservedKind", reservedAsStorage))
    if (!decided.result.cancelled) return false
    yield* Option.match(decided.result.open, { onNone: () => Effect.void, onSome: (turn) => sessions.cancel(child, turn).pipe(Effect.asVoid) })
    yield* sessions.transact(parent, () => Effect.succeed({ drafts: [{ kind: TASK_CANCELLED, data: { taskId } }], result: undefined }))
      .pipe(Effect.catchTag("ReservedKind", reservedAsStorage))
    return true
  })

  const reconcile = (parent: SessionAddress) => Effect.gen(function* () {
    const tasks = yield* listOf(parent)
    const delivered = yield* Effect.forEach(tasks.filter((task) => isFinished(task.status) && !task.delivered), (task) => deliverNotice(parent, task))
    const waiting = tasks.filter((task) => task.status === "pending")
    yield* Effect.forEach(waiting, (task) => runner.run(work(parent, task.taskId)), { discard: true })
    return { delivered: delivered.filter((done) => done.delivered).length, started: waiting.length }
  })

  return Tasks.of({ start, status: taskOf, list: listOf, cancel, reconcile })
}))
