import { Schema } from "effect"
import { ConversationId, InboxItem, InboxItemId, JsonObject, QueuedInput, RunId, TaskMode, TaskQuestion, TaskQuestionId, TurnEndReason, TurnFailure } from "@xandreed/core"

/*
 * What the tasks plugin records. In the parent: `task.started` (the outbox
 * of work to run) and `task.cancelled`. In the child: `task.result`, written
 * before its turn closes (the outbox of a result to deliver), or
 * `task.cancelled`; whichever comes first is the task's end.
 */

export const TASK_STARTED = "task.started"
export const TASK_RESULT = "task.result"
export const TASK_CANCELLED = "task.cancelled"
/** @public */
export const TASK_QUESTIONED = "task.questioned"
/** @public */
export const TASK_ANSWERED = "task.answered"

/** The accepted question and the exact notice to deliver to its parent. @public */
export const TaskQuestioned = Schema.Struct({
  taskId: ConversationId,
  question: TaskQuestion,
  input: Schema.optionalKey(InboxItemId),
  notice: InboxItem,
})
export type TaskQuestioned = typeof TaskQuestioned.Type

/** An accepted answer and its exact normalized child input, retained after consumption. @public */
export const TaskAnswered = Schema.Struct({
  taskId: ConversationId,
  questionId: TaskQuestionId,
  text: Schema.String,
  input: QueuedInput,
})
export type TaskAnswered = typeof TaskAnswered.Type

/**
 * The turn whose run started a task (the model's `start_task`): its run id and number.
 *
 * @public
 */
export const TaskStarter = Schema.Struct({ runId: RunId, turn: Schema.Int })
export type TaskStarter = typeof TaskStarter.Type

export const TaskStarted = Schema.Struct({
  taskId: ConversationId,
  instructions: Schema.String,
  mode: TaskMode,
  /** The starter's metadata (`Tasks.start`'s `meta`): the task's turns are begun with it. */
  meta: JsonObject,
  /**
   * The turn whose run started the task, written only when given. A task
   * started before it was recorded here may carry that run's id in
   * `meta.runId`.
   */
  startedBy: Schema.optionalKey(TaskStarter),
})
export type TaskStarted = typeof TaskStarted.Type

/** @public */
export const TaskOutcome = TurnEndReason.pick(["completed", "partial", "failed", "interrupted"])
export type TaskOutcome = typeof TaskOutcome.Type

export const TaskResult = Schema.Struct({
  taskId: ConversationId,
  outcome: TaskOutcome,
  reply: Schema.OptionFromNullOr(Schema.String),
  failure: Schema.OptionFromNullOr(TurnFailure),
})
export type TaskResult = typeof TaskResult.Type

export const TaskCancelled = Schema.Struct({ taskId: ConversationId })

/** @public */
export const TasksConfig = Schema.Struct({
  /** Tasks a session may have waiting or running at once. */
  maxRunning: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  /** Offer the model `start_task` and `task_status`. */
  tools: Schema.Boolean,
  /** A longer result reaches the parent cut to this many characters. */
  replyChars: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 100_000 })),
  /**
   * Of a runner's finite budget, the time execution leaves for what follows
   * it: the child's result and ending, the delivery and the parent's
   * closing commits (several store round trips). At most half the budget.
   */
  closingReserveMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 600_000 })),
})
export type TasksConfig = typeof TasksConfig.Type

export const tasksDefaults: TasksConfig = { maxRunning: 2, tools: false, replyChars: 12_000, closingReserveMs: 2_000 }
