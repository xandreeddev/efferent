import { Schema } from "effect"
import { SessionId } from "@xandreed/core/kernel"

/**
 * A task's name: `t` and a number (`t3`), short enough for a model to write back. The plugin mints it, one more than
 * the tasks it started; it starts again with the plugin, so a client keys a task by its session, which never repeats.
 *
 * @public
 */
export const TaskId = Schema.String.check(Schema.isPattern(/^t[1-9][0-9]{0,8}$/)).pipe(Schema.brand("TaskId"))
export type TaskId = typeof TaskId.Type

/**
 * The owner of a task's session: a child of the session that started it, in the plugin's own words.
 *
 * @public
 */
export const TASKS_OWNER = "plugin.tasks"

/**
 * The most characters of a task's text: the helper is sent it whole, and the call that starts the task keeps it.
 *
 * @public
 */
export const TASK_LIMIT = 2000

/**
 * The most characters of a task's answer that its report carries: the report is a message every later prompt sends.
 *
 * @public
 */
export const REPORT_LIMIT = 4000

/**
 * The most tasks that run at once, when the host gives no other number.
 *
 * @public
 */
export const DEFAULT_RUNNING = 4

/**
 * How a task ended, as its report says: its work returned an answer (`Finished`), or failed (`Failed`). A task that
 * was cancelled, or that the plugin's close interrupted, reports nothing.
 *
 * @public
 */
export const TaskOutcome = Schema.Literals(["Finished", "Failed"])
export type TaskOutcome = typeof TaskOutcome.Type

/**
 * A task that ended (ADR 0018): the task, the session that started it (`parent`, where the report goes), its own
 * session, how it ended, and its answer, or why it failed, in words a model reads.
 *
 * @public
 */
export const TaskReport = Schema.Struct({ task: TaskId, parent: SessionId, session: SessionId, outcome: TaskOutcome, text: Schema.String })
export type TaskReport = typeof TaskReport.Type

/**
 * What `startTask` answers, at once: the task's id, and its session.
 *
 * @public
 */
export const StartedTask = Schema.Struct({ task: TaskId, session: SessionId })
export type StartedTask = typeof StartedTask.Type

/**
 * A task could not start: as many tasks run as may run at once. Its message is the words the model reads.
 *
 * @public
 */
export class TaskRefused extends Schema.TaggedError<TaskRefused>()("TaskRefused", {
  message: Schema.String,
}) {}

/**
 * The options of `tasks`: how many tasks run at once (`DEFAULT_RUNNING` when left out). A task counts as running
 * until its report is delivered.
 *
 * @public
 */
export interface TasksOptions {
  readonly running?: number
}

/**
 * The name of the tool that starts a task.
 *
 * @public
 */
export const START_TASK = "startTask"

/**
 * The name of the tool that cancels a task.
 *
 * @public
 */
export const CANCEL_TASK = "cancelTask"
