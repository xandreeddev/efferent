import { Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { TurnEndReason, TurnFailure } from "../domain/turn-vocabulary.entity.js"
import { TaskQuestion } from "./task-question.entity.js"

/*
 * Background tasks: a turn starts a task, the task runs in a
 * child session (a fork of the conversation, or a fresh spawn), and its
 * result is delivered to the parent's inbox, so the parent reacts after
 * whatever answer is in flight. Questions suspend a child until an answer
 * reaches its durable inbox for a later turn.
 */

export const TaskMode = Schema.Literals(["fork", "spawn"])
export type TaskMode = typeof TaskMode.Type

/** Where a task stands, read from its child session. */
export const TaskStatus = Schema.Literals(["pending", "running", ...TurnEndReason.literals])
export type TaskStatus = typeof TaskStatus.Type

/**
 * The task a turn runs: its id (its child session's) and the session that
 * started it. A task's turn carries it (`BeginTurn.Task`, `AdmittedTurn`,
 * `TurnToAdmit`, the stored `turn.started`).
 */
export const TaskRef = Schema.Struct({ taskId: ConversationId, parent: ConversationId })
export type TaskRef = typeof TaskRef.Type

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
  failure: Schema.OptionFromNullOr(TurnFailure),
  /** Whether the result reached the parent's inbox. */
  delivered: Schema.Boolean,
  /** The outstanding question, omitted when the task has no question waiting for an answer. */
  question: Schema.optionalKey(TaskQuestion),
})
export type TaskView = typeof TaskView.Type

/** A task that may not start: tasks do not start tasks, and a session runs so many at once. */
export class TaskRefused extends Schema.TaggedError<TaskRefused>()("TaskRefused", {
  session: ConversationId,
  reason: Schema.Literals(["depth", "limit"]),
  message: Schema.String,
}) {}

/** The task id was started before with other instructions or another mode: a retry of a start is the same task, anything else under its id is refused. */
export class TaskConflict extends Schema.TaggedError<TaskConflict>()("TaskConflict", {
  session: ConversationId,
  taskId: ConversationId,
}) {}

export class TaskMissing extends Schema.TaggedError<TaskMissing>()("TaskMissing", {
  session: ConversationId,
  taskId: ConversationId,
}) {}

/** A task control which its current state or the supplied asking context cannot accept. */
export class TaskControlRefused extends Schema.TaggedError<TaskControlRefused>()("TaskControlRefused", {
  session: ConversationId,
  taskId: ConversationId,
  reason: Schema.Literals(["inactive", "waiting", "question", "context"]),
  message: Schema.String,
}) {}
