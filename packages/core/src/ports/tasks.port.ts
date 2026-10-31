import { Context } from "effect"
import type { Effect, Option } from "effect"
import type { AttachmentRejected } from "../domain/media.entity.js"
import type { ConversationId } from "../domain/message.entity.js"
import type { RunId } from "../domain/run.entity.js"
import type { JsonObject, SessionExists, SessionLogError, SessionMissing } from "../session/session-log.entity.js"
import type { InboxFull, InputConflict, QueuedInput, SessionAddress, SessionContended, TurnError } from "../session/sessions.entity.js"
import type { TaskQuestion, TaskQuestionId } from "../session/task-question.entity.js"
import type { TaskConflict, TaskControlRefused, TaskMissing, TaskMode, TaskRefused, TaskView } from "../session/tasks.entity.js"
import type { TurnWriter } from "./sessions.port.js"
import type { TurnOutcome } from "./turn.port.js"

/**
 * Background tasks of a session. A task runs in a child session: a
 * fork (its history is the conversation so far) or a spawn (it starts
 * empty); the child's id is the task's, and its initial turn's origin is
 * `task` (`BeginTurn.Task`). Questions end a turn waiting, with answers
 * admitted as later queued user turns in the same child. A task's session starts no task (`TaskRefused`
 * `depth`); any other session may, a host's own fork included. Starting records `task.started` in
 * the parent and hands the work to the host's TaskRunner; when the child's
 * turn ends, its result is delivered to the parent's inbox (once) and the
 * parent is drained, so it reacts after the answer in flight. `reconcile`
 * finishes what a lost runner left undone; its caller drains.
 */
export class Tasks extends Context.Service<Tasks, {
  /**
   * Start a task. The child session is created once `task.started` is
   * stored, so a start that is refused or not stored leaves no child.
   * Valid current trace ancestry is stored once for execution and recovery;
   * invalid or disabled tracing omits it without failing the task.
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
    /**
     * The starter's metadata: the child's turn and the parent's reactions to
     * the task's result are begun with it (`BeginTurn.meta`), so a
     * `TurnAdmission` counts them as the starter's.
     */
    readonly meta?: JsonObject
    /** The turn whose run started the task (the model's `start_task`), recorded in `task.started` beside `meta`. */
    readonly startedBy?: { readonly runId: RunId; readonly turn: number }
  }) => Effect.Effect<TaskView, TaskRefused | TaskConflict | SessionExists | SessionMissing | SessionContended | SessionLogError>
  readonly status: (parent: SessionAddress, taskId: ConversationId) => Effect.Effect<TaskView, TaskMissing | SessionMissing | SessionLogError>
  readonly list: (parent: SessionAddress) => Effect.Effect<ReadonlyArray<TaskView>, SessionMissing | SessionLogError>
  /** Durably steer an active child; a waiting child needs an answer to its question instead. */
  readonly steer: (parent: SessionAddress, taskId: ConversationId, input: Omit<QueuedInput, "delivery">) =>
    Effect.Effect<{ readonly enqueued: boolean; readonly pending: number }, TaskMissing | SessionMissing | SessionContended | SessionLogError | TaskControlRefused | TaskConflict | InboxFull | InputConflict | AttachmentRejected>
  /**
   * Accept a question from this task's current writer. Exact retries are
   * idempotent; another payload under its id conflicts. At most one new
   * question is accepted per writer turn, even after an early answer. Its
   * asking turn ends waiting without a final task result.
   */
  readonly ask: (writer: TurnWriter, input: TaskQuestion) => Effect.Effect<TaskQuestion, TurnError | TaskControlRefused | TaskConflict>
  /**
   * Store the answer and enqueue its exact next-turn input. A full inbox
   * leaves an accepted durable answer for reconcile, with enqueued false.
   * Exact duplicate answers never execute the child again.
   */
  readonly answer: (parent: SessionAddress, taskId: ConversationId, input: { readonly questionId: TaskQuestionId; readonly text: string }) =>
    Effect.Effect<{ readonly accepted: true; readonly enqueued: boolean }, TaskMissing | SessionMissing | SessionContended | SessionLogError | TaskControlRefused | TaskConflict>
  /**
   * Execute an already-begun task follow-up on exactly this borrowed writer.
   * The caller owns its scope and end; no turn is begun or ended here.
   * Failed, partial or interrupted follow-ups retain their queued input.
   */
  readonly execute: (writer: TurnWriter) => Effect.Effect<TurnOutcome, TurnError>
  /** Stop a task: its child's turn is cancelled and nothing is delivered. */
  readonly cancel: (parent: SessionAddress, taskId: ConversationId) => Effect.Effect<boolean, TaskMissing | SessionMissing | SessionContended | SessionLogError>
  /** Repair durable delivery and start unrun tasks; react explicitly schedules a notices-only parent drain. */
  readonly reconcile: (parent: SessionAddress, options?: { readonly takeOver?: boolean; readonly react?: boolean }) =>
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

/**
 * How the host runs the turns tasks need: the child's initial and follow-up turns, and the
 * parent's reaction to results. Both run with `Tasks` in context, the
 * `Tasks` whose work they are (the tasks plugin provides its own around the
 * turns it hands over; a host that calls `react` itself, to drain a parent,
 * provides its own), so the turns' `start_task` and `task_status` find it
 * wherever the work runs. `agentTaskExecutor` (`@xandreed/sdk`) runs both
 * through an agent's `turn`, with that `Tasks` among the turn's services.
 */
export class TaskExecutor extends Context.Service<TaskExecutor, {
  /** Run the child's turn on its writer (the tasks plugin ends it). */
  readonly turn: (writer: TurnWriter, task: TaskView, controls?: {
    /** Sticky to an accepted question of this writer, including an early-answered question and trusted resume ancestry. */
    readonly waiting: Effect.Effect<boolean, TurnError>
  }) => Effect.Effect<TurnOutcome, TurnError, Tasks>
  /** Run the parent's inbox turn on its writer. */
  readonly react: (writer: TurnWriter) => Effect.Effect<void, TurnError, Tasks>
}>()("efferent/TaskExecutor") {}
