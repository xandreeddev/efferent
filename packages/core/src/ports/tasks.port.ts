import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { ConversationId } from "../domain/message.entity.js"
import type { HarnessError } from "../harness/plugin.entity.js"
import type { JsonObject, SessionExists, SessionLogError, SessionMissing } from "../session/session-log.entity.js"
import type { SessionAddress, SessionContended } from "../session/sessions.entity.js"
import type { TaskConflict, TaskMissing, TaskMode, TaskRefused, TaskView } from "../session/tasks.entity.js"
import type { TurnWriter } from "./sessions.port.js"
import type { TurnOutcome } from "./turn.port.js"

/**
 * Background tasks of a session. A task is one turn of a child session: a
 * fork (its history is the conversation so far) or a spawn (it starts
 * empty); the child's id is the task's. Starting records `task.started` in
 * the parent and hands the work to the host's TaskRunner; when the child's
 * turn ends, its result is delivered to the parent's inbox (once) and the
 * parent is drained, so it reacts after the answer in flight. `reconcile`
 * finishes what a lost runner left undone; its caller drains.
 */
export class Tasks extends Context.Service<Tasks, {
  /**
   * Start a task. The child session is created once `task.started` is
   * stored, so a start that is refused or not stored leaves no child.
   */
  readonly start: (parent: SessionAddress, input: {
    /**
     * Stable across retries: starting the same task twice starts it once (a
     * retry also creates the child a start that stopped half way left
     * without one). The same id with other instructions or another mode is
     * `TaskConflict`; an id naming a session that is not this parent's task
     * child is `SessionExists`.
     */
    readonly taskId?: ConversationId
    readonly instructions: string
    readonly mode: TaskMode
    readonly meta?: JsonObject
  }) => Effect.Effect<TaskView, TaskRefused | TaskConflict | SessionExists | SessionMissing | SessionContended | SessionLogError>
  readonly status: (parent: SessionAddress, taskId: string) => Effect.Effect<TaskView, TaskMissing | SessionMissing | SessionLogError>
  readonly list: (parent: SessionAddress) => Effect.Effect<ReadonlyArray<TaskView>, SessionMissing | SessionLogError>
  /** Stop a task: its child's turn is cancelled and nothing is delivered. */
  readonly cancel: (parent: SessionAddress, taskId: string) => Effect.Effect<boolean, TaskMissing | SessionMissing | SessionContended | SessionLogError>
  /** Deliver finished results a runner lost, and start tasks that never ran. */
  readonly reconcile: (parent: SessionAddress) =>
    Effect.Effect<{ readonly delivered: number; readonly started: number }, SessionMissing | SessionContended | SessionLogError>
}>()("efferent/Tasks") {}

/**
 * Where background work runs: a fiber of this process, or the host's own
 * mechanism (e.g. a serverless waitUntil). `run` returns once the work is
 * handed over; the work is told when it must be done by (Clock time), if
 * the runner has a limit, so a task ends interrupted rather than lost. The
 * work goes on after its caller (the turn that started a task) ends, and
 * runs without the caller's services; on fibers of this process, it is
 * interrupted when the runner's scope closes. `taskRunnerConformance`
 * checks a runner.
 */
export class TaskRunner extends Context.Service<TaskRunner, {
  readonly run: (work: (deadline: Option.Option<number>) => Effect.Effect<void>) => Effect.Effect<void>
}>()("efferent/TaskRunner") {}

/** How the host runs the turns tasks need: the child's one turn, and the parent's reaction to results. */
export class TaskExecutor extends Context.Service<TaskExecutor, {
  /** Run the child's turn on its writer (the tasks plugin ends it). */
  readonly turn: (writer: TurnWriter, task: TaskView) => Effect.Effect<TurnOutcome, HarnessError>
  /** Run the parent's inbox turn on its writer. */
  readonly react: (writer: TurnWriter) => Effect.Effect<void, HarnessError>
}>()("efferent/TaskExecutor") {}
