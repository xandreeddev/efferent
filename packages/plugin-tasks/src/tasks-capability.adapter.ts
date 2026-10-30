import { Tool } from "effect/ai"
import { Effect, Option, Schema } from "effect"
import { ConversationId, defineCapability, defineSkill, defineTool, Failure, RunContext, TaskMode, Tasks, TaskStatus } from "@xandreed/core"

const StartTask = Tool.make("start_task", {
  description: "Start a background task: another run of you works on the instructions while this conversation goes on, and its result comes back here when it finishes, for you to answer then. Use it for long work the user need not wait for, and say that you started it. Put everything the task needs in instructions: with mode spawn it sees only them; with mode fork it also sees this conversation up to the user's latest message, but not that message or anything you did since. A background task cannot start another.",
  parameters: Schema.Struct({ instructions: Schema.String, mode: TaskMode }),
  success: Schema.Struct({ taskId: Schema.String, status: TaskStatus }),
  failure: Failure,
  failureMode: "return",
})

const TaskStatusTool = Tool.make("task_status", {
  description: "Check a background task this conversation started: whether it is still running, and its result once it has one.",
  parameters: Schema.Struct({ taskId: Schema.String }),
  success: Schema.Struct({ taskId: Schema.String, status: TaskStatus, reply: Schema.NullOr(Schema.String) }),
  failure: Failure,
  failureMode: "return",
})

const unavailable = (error: { readonly _tag: string }) => ({ error: "TasksUnavailable", message: `Background tasks are unavailable right now (${error._tag})` })

/** A task id as the model gives it: a task's id is its child session's, so a string that is not one names no task. */
const taskIdOf = Schema.decodeUnknownOption(ConversationId)

/** The model's way to start background tasks and check on them. */
export const tasksCapability = defineCapability({
  id: "@xandreed/plugin-tasks/tools",
  version: "1",
  tools: [
    defineTool({
      tool: StartTask,
      requires: [RunContext, Tasks],
      handler: ({ instructions, mode }) => Effect.gen(function* () {
        const run = yield* RunContext
        const tasks = yield* Tasks
        // The turn's own metadata (a tenant, a quota key) goes with the task, so its turns are admitted as the starter's.
        const task = yield* tasks.start(run.session, { instructions, mode, meta: run.admitted.meta, startedBy: { runId: run.runId, turn: run.admitted.turn } }).pipe(Effect.mapError((error) =>
          error._tag === "TaskRefused" ? { error: "TaskRefused", message: error.message } : unavailable(error)))
        return { taskId: task.taskId, status: task.status }
      }),
    }),
    defineTool({
      tool: TaskStatusTool,
      requires: [RunContext, Tasks],
      handler: ({ taskId }) => Effect.gen(function* () {
        const run = yield* RunContext
        const tasks = yield* Tasks
        const unknown = { error: "UnknownTask", message: `No task ${taskId} was started in this conversation` }
        const task = yield* Option.match(taskIdOf(taskId), {
          onNone: () => Effect.fail(unknown),
          onSome: (id) => tasks.status(run.session, id).pipe(Effect.mapError((error) => error._tag === "TaskMissing" ? unknown : unavailable(error))),
        })
        return { taskId: task.taskId, status: task.status, reply: Option.getOrNull(task.reply) }
      }),
      annotations: { readOnly: true },
    }),
  ],
  skills: [defineSkill({ id: "tasks.background", summary: "Run long work in the background and check on it.", tools: ["start_task", "task_status"], always: true })],
})
