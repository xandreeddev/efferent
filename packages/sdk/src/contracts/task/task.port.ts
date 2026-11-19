import { Context } from "effect"
import type { Effect } from "effect"
import type { SessionId } from "@xandreed/core"
import type { StartedTask, TaskId, TaskRefused, TaskReport } from "./task.entity.js"

/**
 * Work that goes on while the conversation does (ADR 0018). A task runs in a session of its own, a child of the one
 * that started it, on the plugin's scope and not the turn's: `start` returns at once, and the turn that started it
 * goes on and ends. When the task's work ends, its report goes to the host's `TaskReports`, which puts it where the
 * program takes its next message, so the program answers it in a turn of the parent's own: one turn at a time.
 *
 * - `start(parent, task)`: start a task for the session `parent`, refused while as many run as may.
 * - `cancel(parent, task)`: interrupt a task the session `parent` started and that still runs; whether one did. A
 *   cancelled task reports nothing.
 *
 * A task's work lives in the process: the plugin's scope closing cuts every task short, and none of them reports.
 *
 * @public
 */
export class Tasks extends Context.Service<Tasks, {
  readonly start: (parent: SessionId, task: string) => Effect.Effect<StartedTask, TaskRefused>
  readonly cancel: (parent: SessionId, task: TaskId) => Effect.Effect<boolean>
}>()("@xandreed/sdk/kernel/Tasks") {}

/**
 * Where a task's report goes when it ends (ADR 0018), which the host provides: into the one queue its program's loop
 * takes the person's messages from, so a report is answered between turns and never inside one, and nothing races.
 * `deliver` may wait (a full queue): the task is counted as running until its report is delivered.
 *
 * @public
 */
export class TaskReports extends Context.Service<TaskReports, {
  readonly deliver: (report: TaskReport) => Effect.Effect<void>
}>()("@xandreed/sdk/kernel/TaskReports") {}
