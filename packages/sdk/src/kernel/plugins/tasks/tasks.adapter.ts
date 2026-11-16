import { Cause, Effect, Exit, Fiber, Layer, Option, Predicate, Ref, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { Sessions } from "@xandreed/core/kernel"
import type { OpenSession, SessionId } from "@xandreed/core/kernel"
import { CANCEL_TASK, DEFAULT_RUNNING, START_TASK, StartedTask, TASK_LIMIT, TaskRefused, TASKS_OWNER } from "../../contracts/task/task.entity.js"
import type { TaskId, TaskReport, TasksOptions } from "../../contracts/task/task.entity.js"
import { cancelledTask, nextTaskId, noTaskRunning, TASK_DIED, taskFrom, taskIdOf, tooMany } from "../../contracts/task/task.entity.functions.js"
import { TaskReports, Tasks } from "../../contracts/task/task.port.js"
import { CurrentTurn } from "../../contracts/turn/current-turn.port.js"

/**
 * The work of one task, the host's (ADR 0018): a turn in the task's own session, from the task's text to its answer.
 * It runs while the conversation goes on, so it is an agent of its own (lesson 4's helper), never the conversation's
 * loop. The kernel calls no model: this does.
 *
 * @public
 */
export type TaskRun<E, R> = (session: OpenSession, task: string) => Effect.Effect<string, E, R>

/** What a task that ran tells its report: its answer, or why it failed, in words a model reads. */
const ended = <E>(exit: Exit.Exit<string, E>): Option.Option<{ readonly outcome: TaskReport["outcome"]; readonly text: string }> =>
  Exit.match(exit, {
    onSuccess: (text) => Option.some({ outcome: "Finished" as const, text }),
    onFailure: (cause) => {
      // A task cancelled, or cut short by the plugin's close, reports nothing.
      if (Cause.hasInterruptsOnly(cause)) return Option.none()
      const words = Option.flatMap(Cause.findErrorOption(cause), (error) =>
        Predicate.hasProperty(error, "message") && typeof error.message === "string" && error.message.trim().length > 0 ? Option.some(error.message) : Option.none())
      return Option.some({ outcome: "Failed" as const, text: Option.getOrElse(words, () => TASK_DIED) })
    },
  })

interface Running {
  readonly started: number
  /** The tasks that run, by id: the session that started each, and its fiber once it is forked. */
  readonly tasks: ReadonlyMap<TaskId, { readonly parent: SessionId; readonly fiber: Option.Option<Fiber.Fiber<void>> }>
}

/**
 * Background tasks (ADR 0018): `Tasks` over the host's `run`. Each task is a session of its own, a child of the one
 * that started it (owner `plugin.tasks`), and one turn in it on a fiber of the plugin's scope, so `start` returns at
 * once. When it ends, its report goes to the host's `TaskReports`; a task counts as running until the report is
 * delivered. At most `running` tasks (`DEFAULT_RUNNING`) run at once: `start` refuses the next with `TaskRefused`. A
 * cancelled task, and every task the plugin's close cuts short, reports nothing.
 *
 * @public
 */
export const tasks = <E, R>(run: TaskRun<E, R>, options: TasksOptions = {}): Layer.Layer<Tasks, never, Sessions | TaskReports | R> =>
  Layer.effect(Tasks, Effect.gen(function* () {
    const sessions = yield* Sessions
    const reports = yield* TaskReports
    const services = yield* Effect.context<R>()
    const scope = yield* Effect.scope
    const limit = options.running ?? DEFAULT_RUNNING
    const state = yield* Ref.make<Running>({ started: 0, tasks: new Map() })
    const without = (task: TaskId) => (held: Running): Running => ({ ...held, tasks: new Map([...held.tasks].filter(([id]) => id !== task)) })

    /** One task: its turn, then its report delivered; it leaves the running ones when both are done, or it is cut short. */
    const work = (task: TaskId, parent: SessionId, session: SessionId, text: string): Effect.Effect<void> =>
      Effect.exit(Effect.provide(sessions.turn(session, (open) => run(open, text)), services)).pipe(
        Effect.flatMap((exit) => Option.match(ended(exit), {
          onNone: () => Effect.void,
          onSome: (end) => reports.deliver({ task, parent, session, ...end }),
        })),
        Effect.ensuring(Ref.update(state, without(task))),
      )

    return Tasks.of({
      start: Effect.fn("kernel.tasks.start")((parent: SessionId, text: string) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
        // The slot and the id are taken in one step, so two starts at once never pass the limit together.
        const task = yield* Effect.flatMap(Ref.modify(state, (held): readonly [Option.Option<TaskId>, Running] => {
          if (held.tasks.size >= limit) return [Option.none(), held]
          const id = nextTaskId(held.started)
          return [Option.some(id), { started: held.started + 1, tasks: new Map([...held.tasks, [id, { parent, fiber: Option.none() }]]) }]
        }), Option.match({ onNone: () => Effect.fail(new TaskRefused({ message: tooMany(limit) })), onSome: Effect.succeed }))
        // Only the store's call can be cut. However it ends but well (a failure, a defect, an interruption), the slot
        // is given back; a store that fails is a defect of the call, as it is in the facts tools.
        const session = yield* Effect.orDie(restore(sessions.create({ owner: TASKS_OWNER, parent })).pipe(Effect.onError(() => Ref.update(state, without(task)))))
        // The fiber is forked and recorded before the task can run.
        const fiber = yield* Effect.forkIn(work(task, parent, session, text), scope, { startImmediately: false })
        yield* Ref.update(state, (held) => {
          const entry = held.tasks.get(task)
          return entry === undefined ? held : { ...held, tasks: new Map([...held.tasks, [task, { ...entry, fiber: Option.some(fiber) }]]) }
        })
        return { task, session }
      }))),
      cancel: (parent, task) => Effect.flatMap(Ref.get(state), (held) => {
        const entry = held.tasks.get(task)
        // A session cancels only the tasks it started.
        return entry === undefined || entry.parent !== parent || Option.isNone(entry.fiber) ? Effect.succeed(false) : Effect.as(Fiber.interrupt(entry.fiber.value), true)
      }),
    })
  }))

/**
 * The tool that starts a task (ADR 0018): a helper works on it in a session of its own while the conversation goes
 * on, and its answer comes later, as a message of its own. It answers at once with the task's id and session.
 *
 * @public
 */
export const StartTask = Tool.make(START_TASK, {
  description: `Start a task that a helper works on in the background, while the conversation goes on. Returns the task's id at once, such as t1. The helper's answer comes later, as a message of its own that starts with a host note naming the task: answer the user then. Use it for work that takes a while and need not be waited for. To stop a task, call ${CANCEL_TASK} with its id.`,
  parameters: Schema.Struct({
    task: Schema.String.annotate({ description: `What the helper is to do, said in full: it sees only this text, not the conversation. At most ${TASK_LIMIT} characters.` }),
  }),
  success: StartedTask,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Tasks, CurrentTurn],
})

/**
 * The tool that cancels a task that still runs (ADR 0018). A cancelled task reports nothing.
 *
 * @public
 */
export const CancelTask = Tool.make(CANCEL_TASK, {
  description: `Stop a task that is still running. Returns that it was cancelled; a cancelled task sends no answer. A task that has ended has sent its answer already.`,
  parameters: Schema.Struct({
    task: Schema.String.annotate({ description: `The task's id, as ${START_TASK} returned it, such as t1.` }),
  }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
  dependencies: [Tasks, CurrentTurn],
})

/**
 * The two task tools: a host merges them into its own toolkit, `Toolkit.merge(tools, taskTools)`, which keeps each
 * tool's type, so a program that leaves `Tasks` out does not compile where it calls them.
 *
 * @public
 */
export const taskTools = Toolkit.make(StartTask, CancelTask)

/**
 * What the two task tools do: `startTask` starts a task for the session its call runs in (the caller, from
 * `CurrentTurn`), `cancelTask` stops one that session started. A text that is no task, as many tasks running as may, and an id no running
 * task has are failed results the model reads.
 *
 * @public
 */
export const taskHandlers = taskTools.toLayer({
  startTask: ({ task }) => Effect.gen(function* () {
    const caller = yield* CurrentTurn
    const text = yield* Effect.fromResult(taskFrom(task))
    return yield* Effect.mapError((yield* Tasks).start(caller.id, text), (refused) => refused.message)
  }),
  cancelTask: ({ task }) => Effect.gen(function* () {
    const caller = yield* CurrentTurn
    const id = yield* Option.match(taskIdOf(task), { onNone: () => Effect.fail(noTaskRunning(task)), onSome: Effect.succeed })
    return (yield* (yield* Tasks).cancel(caller.id, id)) ? cancelledTask(id) : yield* Effect.fail(noTaskRunning(task))
  }),
})
