import { Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"

/*
 * Background tasks: a turn starts a task, the task runs as one turn of a
 * child session (a fork of the conversation, or a fresh spawn), and its
 * result is delivered to the parent's inbox, so the parent reacts after
 * whatever answer is in flight.
 */

export const TaskMode = Schema.Literals(["fork", "spawn"])
export type TaskMode = typeof TaskMode.Type

/** Where a task stands, read from its child session. */
export const TaskStatus = Schema.Literals(["pending", "running", "completed", "partial", "failed", "interrupted", "cancelled"])
export type TaskStatus = typeof TaskStatus.Type

export const TaskView = Schema.Struct({
  taskId: ConversationId,
  parent: ConversationId,
  child: ConversationId,
  instructions: Schema.String,
  mode: TaskMode,
  status: TaskStatus,
  /** The child's final reply, once it has one. */
  reply: Schema.OptionFromNullOr(Schema.String),
  /** Why it did not complete (refused, out of time, failed), when that is known. */
  failure: Schema.OptionFromNullOr(Schema.Struct({ code: Schema.String, message: Schema.String })),
  /** Whether the result reached the parent's inbox. */
  delivered: Schema.Boolean,
})
export type TaskView = typeof TaskView.Type

/** A task that may not start: tasks do not start tasks, and a session runs so many at once. */
export class TaskRefused extends Schema.TaggedError<TaskRefused>()("TaskRefused", {
  session: ConversationId,
  reason: Schema.Literals(["depth", "limit"]),
  message: Schema.String,
}) {}

export class TaskMissing extends Schema.TaggedError<TaskMissing>()("TaskMissing", {
  session: ConversationId,
  taskId: Schema.String,
}) {}
