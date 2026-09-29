import { Schema } from "effect"
import { ConversationId, JsonObject, TaskMode } from "@xandreed/core"

/*
 * What the tasks plugin records. In the parent: `task.started` (the outbox
 * of work to run) and `task.cancelled`. In the child: `task.result`, written
 * before its turn closes (the outbox of a result to deliver), or
 * `task.cancelled`; whichever comes first is the task's end.
 */

export const TASK_STARTED = "task.started"
export const TASK_RESULT = "task.result"
export const TASK_CANCELLED = "task.cancelled"

export const TaskStarted = Schema.Struct({
  taskId: ConversationId,
  instructions: Schema.String,
  mode: TaskMode,
  /** The starter's own facts (e.g. the run that started it). */
  meta: JsonObject,
})
export type TaskStarted = typeof TaskStarted.Type

export const TaskOutcome = Schema.Literals(["completed", "partial", "failed", "interrupted"])
export type TaskOutcome = typeof TaskOutcome.Type

export const TaskFailure = Schema.Struct({ code: Schema.String, message: Schema.String })

export const TaskResult = Schema.Struct({
  taskId: ConversationId,
  outcome: TaskOutcome,
  reply: Schema.OptionFromNullOr(Schema.String),
  failure: Schema.OptionFromNullOr(TaskFailure),
})
export type TaskResult = typeof TaskResult.Type

export const TaskCancelled = Schema.Struct({ taskId: ConversationId })

export const TasksConfig = Schema.Struct({
  /** Tasks a session may have waiting or running at once. */
  maxRunning: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 })),
  /** Offer the model `start_task` and `task_status`. */
  tools: Schema.Boolean,
  /** A longer result reaches the parent cut to this many characters. */
  replyChars: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 100_000 })),
})
export type TasksConfig = typeof TasksConfig.Type

export const tasksDefaults: TasksConfig = { maxRunning: 2, tools: false, replyChars: 12_000 }
