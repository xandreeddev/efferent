import { Tool } from "effect/ai"
import { Effect, Match, Option, Schema } from "effect"
import { canonicalJson, ConversationId, CurrentAgentRun, CurrentAgentStep, CurrentToolInvocation, defineCapability, defineSkill, defineTool, Failure, InboxItemId, RunContext, TaskMode, TaskQuestionId, Tasks, TaskStatus, UserMessage } from "@xandreed/core"
import { controlText } from "./task-controls.entity.functions.js"
import { CurrentTaskWriter } from "./tasks-context.port.js"

const StartTask = Tool.make("start_task", {
  description: "Start a background task: another run of you works on the instructions while this conversation goes on, and its result comes back here when it finishes, for you to answer then. Use it for long work the user need not wait for, and say that you started it. Put everything the task needs in instructions: with mode spawn it sees only them; with mode fork it also sees this conversation up to the user's latest message, but not that message or anything you did since. A background task cannot start another.",
  parameters: Schema.Struct({ instructions: Schema.String, mode: TaskMode }),
  success: Schema.Struct({ taskId: Schema.String, status: TaskStatus }),
  failure: Failure,
  failureMode: "return",
})

const TaskStatusTool = Tool.make("task_status", {
  description: "Check a background task this conversation started: whether it is running, needs an answer, or has finished. When it needs an answer, use its question id with answer_task.",
  parameters: Schema.Struct({ taskId: Schema.String }),
  success: Schema.Struct({ taskId: Schema.String, status: TaskStatus, reply: Schema.NullOr(Schema.String), question: Schema.NullOr(Schema.Struct({ questionId: TaskQuestionId, text: Schema.String })) }),
  failure: Failure,
  failureMode: "return",
})

const AskParent = Tool.make("ask_parent", {
  description: "Ask the conversation that started this background task for information you need. Returns a question id and ends this turn while you wait; the answer arrives in a later turn. Ask one question per turn. Use this only from a background task, and include everything needed to answer.",
  parameters: Schema.Struct({ text: Schema.NonEmptyString }), success: Schema.Struct({ questionId: TaskQuestionId }), failure: Failure, failureMode: "return",
})
const SteerTask = Tool.make("steer_task", {
  description: "Send a course correction to a background task this conversation started. Returns whether the message was queued and how many inputs are pending. The task reads it at its next step or turn. If the task needs an answer, use answer_task instead.",
  parameters: Schema.Struct({ taskId: Schema.String, text: Schema.NonEmptyString }), success: Schema.Struct({ enqueued: Schema.Boolean, pending: Schema.Int }), failure: Failure, failureMode: "return",
})
const AnswerTask = Tool.make("answer_task", {
  description: "Answer a question from a background task this conversation started. Give the question id from its notice or task_status. Returns accepted once the answer is stored and enqueued when it reached the task's inbox; an accepted answer waits for space automatically. The task continues in a later turn. Use steer_task for a course correction when no question is pending.",
  parameters: Schema.Struct({ taskId: Schema.String, questionId: TaskQuestionId, text: Schema.NonEmptyString }), success: Schema.Struct({ accepted: Schema.Literal(true), enqueued: Schema.Boolean }), failure: Failure, failureMode: "return",
})
const CancelTask = Tool.make("cancel_task", {
  description: "Cancel a background task this conversation started. Returns whether it was cancelled. A task that already finished stays finished; a cancelled task does no more work and sends no result.",
  parameters: Schema.Struct({ taskId: Schema.String }), success: Schema.Struct({ cancelled: Schema.Boolean }), failure: Failure, failureMode: "return",
})

/** The tasks' store failed, or the session went: the model hears that it may try later, never which tag failed. */
const unavailable = () => ({ error: "TasksUnavailable", message: "Background tasks are unavailable right now; try again later, or do the work in this conversation" })

/** A task id as the model gives it: a task's id is its child session's, so a string that is not one names no task. */
const taskIdOf = Schema.decodeUnknownOption(ConversationId)

const contextRequired = () => ({ error: "TaskContextRequired", message: "Use this control from a running step of the conversation or its background task" })
const controlFailure = (error: { readonly _tag: string; readonly message?: string }) => Match.value(error).pipe(
  Match.when({ _tag: "TaskControlRefused" }, (refused) => ({ error: "TaskControlRefused", message: refused.message ?? controlText.context })),
  Match.when({ _tag: "TaskConflict" }, () => ({ error: "TaskConflict", message: "This task control was already stored with different content; check task_status before trying again" })),
  Match.orElse(unavailable),
)
const controlTaskId = (text: string) => Option.match(taskIdOf(text), { onNone: () => Effect.fail({ error: "UnknownTask", message: `No task ${text} was started in this conversation` }), onSome: Effect.succeed })

/** The model's way to start background tasks and check on them. */
export const tasksCapability = defineCapability({
  id: "@xandreed/plugin-tasks/tools",
  version: "2",
  tools: [
    defineTool({
      tool: StartTask,
      requires: [RunContext, Tasks],
      handler: ({ instructions, mode }) => Effect.gen(function* () {
        const run = yield* RunContext
        const tasks = yield* Tasks
        // The turn's own metadata (a tenant, a quota key) goes with the task, so its turns are admitted as the starter's.
        const task = yield* tasks.start(run.session, { instructions, mode, meta: run.admitted.meta, startedBy: { runId: run.runId, turn: run.admitted.turn } }).pipe(Effect.mapError((error) =>
          error._tag === "TaskRefused" ? { error: "TaskRefused", message: error.message } : unavailable()))
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
          onSome: (id) => tasks.status(run.session, id).pipe(Effect.mapError((error) => error._tag === "TaskMissing" ? unknown : unavailable())),
        })
        return { taskId: task.taskId, status: task.status, reply: Option.getOrNull(task.reply), question: task.question === undefined ? null : { questionId: task.question.questionId, text: task.question.text } }
      }),
      annotations: { readOnly: true },
    }),
    defineTool({
      tool: AskParent, requires: [RunContext, Tasks],
      handler: ({ text }) => Effect.gen(function* () {
        const run = yield* RunContext
        const tasks = yield* Tasks
        const writer = yield* Effect.service(CurrentTaskWriter)
        const loop = yield* Effect.service(CurrentAgentRun)
        const step = yield* Effect.service(CurrentAgentStep)
        const invocation = yield* Effect.service(CurrentToolInvocation)
        if (Option.isNone(writer) || writer.value.admitted !== run.admitted || Option.isNone(loop) || Option.isNone(step) || Option.isNone(invocation)) return yield* Effect.fail(contextRequired())
        const question = yield* tasks.ask(writer.value, { questionId: TaskQuestionId.make(canonicalJson(["task-question", invocation.value.invocationId])), text, askedBy: { run: loop.value, step: step.value } }).pipe(Effect.mapError(controlFailure))
        return { questionId: question.questionId }
      }),
    }),
    defineTool({
      tool: SteerTask, requires: [RunContext, Tasks],
      handler: ({ taskId, text }) => Effect.gen(function* () {
        const run = yield* RunContext
        const tasks = yield* Tasks
        const id = yield* controlTaskId(taskId)
        const invocation = yield* Effect.service(CurrentToolInvocation)
        if (Option.isNone(invocation)) return yield* Effect.fail(contextRequired())
        return yield* tasks.steer(run.session, id, { id: InboxItemId.make(canonicalJson(["task-steer", invocation.value.invocationId])), userMessage: new UserMessage({ text }), source: { kind: "task-steer", taskId: id } }).pipe(Effect.mapError(controlFailure))
      }),
    }),
    defineTool({
      tool: AnswerTask, requires: [RunContext, Tasks],
      handler: ({ taskId, questionId, text }) => Effect.gen(function* () {
        const run = yield* RunContext
        const tasks = yield* Tasks
        return yield* tasks.answer(run.session, yield* controlTaskId(taskId), { questionId, text }).pipe(Effect.mapError(controlFailure))
      }),
    }),
    defineTool({
      tool: CancelTask, requires: [RunContext, Tasks],
      handler: ({ taskId }) => Effect.gen(function* () {
        const run = yield* RunContext
        const tasks = yield* Tasks
        return { cancelled: yield* tasks.cancel(run.session, yield* controlTaskId(taskId)).pipe(Effect.mapError(controlFailure)) }
      }),
    }),
  ],
  skills: [defineSkill({ id: "tasks.background", summary: "Run long work in the background and check on it.", tools: ["start_task", "task_status", "ask_parent", "steer_task", "answer_task", "cancel_task"], always: true })],
})
