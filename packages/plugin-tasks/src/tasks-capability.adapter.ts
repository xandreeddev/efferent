import { Tool } from "effect/ai"
import { Effect, Option, Schema } from "effect"
import { defineCapability, defineSkill, defineTool, Failure, RunContext, TaskMode, Tasks, TaskStatus } from "@xandreed/core"

const StartTask = Tool.make("start_task", {
  description: "Start a background task: another run of you works on the instructions while this conversation goes on, and its result comes back here when it finishes, for you to answer then. Use it for long work the user need not wait for, and say that you started it. mode fork: the task sees this conversation so far; spawn: it sees only the instructions.",
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

/** The model's way to start background tasks and check on them. */
export const tasksCapability = defineCapability({
  id: "@xandreed/plugin-tasks/tools",
  version: "1",
  tools: [
    defineTool({
      tool: StartTask,
      handler: ({ instructions, mode }) => Effect.gen(function* () {
        const run = yield* RunContext
        const tasks = yield* Tasks
        const task = yield* tasks.start(run.session, { instructions, mode, meta: { runId: run.runId } }).pipe(Effect.mapError((error) =>
          error._tag === "TaskRefused" ? { error: "TaskRefused", message: error.message } : unavailable(error)))
        return { taskId: task.taskId, status: task.status }
      }),
    }),
    defineTool({
      tool: TaskStatusTool,
      handler: ({ taskId }) => Effect.gen(function* () {
        const run = yield* RunContext
        const tasks = yield* Tasks
        const task = yield* tasks.status(run.session, taskId).pipe(Effect.mapError((error) =>
          error._tag === "TaskMissing" ? { error: "UnknownTask", message: `No task ${taskId} was started in this conversation` } : unavailable(error)))
        return { taskId: task.taskId, status: task.status, reply: Option.getOrNull(task.reply) }
      }),
      annotations: { readOnly: true },
    }),
  ],
  skills: [defineSkill({ id: "tasks.background", summary: "Run long work in the background and check on it.", tools: ["start_task", "task_status"], always: true })],
})
