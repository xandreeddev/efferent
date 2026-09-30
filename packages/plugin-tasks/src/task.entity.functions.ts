import { Cause, Exit, Option, Schema } from "effect"
import { HarnessError } from "@xandreed/core"
import type { SessionLogEvent, SessionView, TaskStatus, TaskView, TurnOutcome } from "@xandreed/core"
import { TASK_CANCELLED, TASK_RESULT, TASK_STARTED, TaskResult, TaskStarted } from "./task-records.entity.js"
import type { TaskResult as Result, TaskStarted as Started } from "./task-records.entity.js"

const decodeStarted = Schema.decodeUnknownOption(TaskStarted)
const decodeResult = Schema.decodeUnknownOption(TaskResult)

/** The inbox id a task's result is delivered under: once per task. */
export const deliveryId = (taskId: string): string => `task:${taskId}`

const FINISHED: ReadonlyArray<TaskStatus> = ["completed", "partial", "failed", "interrupted"]

/** Done and worth telling the parent about (a cancelled task tells nothing). */
export const isFinished = (status: TaskStatus): boolean => FINISHED.includes(status)

/** Waiting to run, or running. */
export const isActive = (status: TaskStatus): boolean => status === "pending" || status === "running"

/** The tasks a parent started, in order; a record that does not decode is skipped. */
export const startedOf = (events: ReadonlyArray<SessionLogEvent>): ReadonlyArray<Started> =>
  events.filter((event) => event.kind === TASK_STARTED).flatMap((event) => Option.toArray(decodeStarted(event.data)))

/** The inbox ids a session has had delivered. */
export const deliveredOf = (events: ReadonlyArray<SessionLogEvent>): ReadonlySet<string> =>
  new Set(events.filter((event) => event.kind === "inbox.queued").map((event) => String(event.data.id)))

export interface TaskEnd {
  readonly status: TaskStatus
  readonly reply: Option.Option<string>
  readonly failure: Option.Option<{ readonly code: string; readonly message: string }>
}

const began = (view: SessionView): boolean =>
  view.turns > Option.match(view.header.parent, { onNone: () => 0, onSome: (lineage) => lineage.turnAtFork })

/**
 * Where a task stands, from its child: the first of its result and its
 * cancellation ends it; otherwise it runs while its turn is held, was
 * interrupted if a turn began and closed without a result, and waits if
 * none began.
 */
export const endOf = (view: SessionView, records: ReadonlyArray<SessionLogEvent>): TaskEnd => {
  const first = records.find((event) => event.kind === TASK_RESULT || event.kind === TASK_CANCELLED)
  if (first?.kind === TASK_CANCELLED) return { status: "cancelled", reply: Option.none(), failure: Option.none() }
  const result = first === undefined ? Option.none<Result>() : decodeResult(first.data)
  if (Option.isSome(result)) return { status: result.value.outcome, reply: result.value.reply, failure: result.value.failure }
  if (Option.isSome(view.open)) return { status: "running", reply: Option.none(), failure: Option.none() }
  return began(view)
    ? { status: "interrupted", reply: Option.none(), failure: Option.some({ code: "task.lost", message: "the task's turn stopped without a result" }) }
    : { status: "pending", reply: Option.none(), failure: Option.none() }
}

/** A child that no longer exists: its parent's removal took it. */
export const goneEnd: TaskEnd = { status: "cancelled", reply: Option.none(), failure: Option.some({ code: "task.removed", message: "the task's session was removed" }) }

/** How the child's turn went, as its result records it: a turn past its deadline is interrupted. */
export const resultOf = (taskId: Result["taskId"], exit: Exit.Exit<Option.Option<TurnOutcome>, HarnessError>): Result => Exit.match(exit, {
  onSuccess: (outcome) => Option.match(outcome, {
    onNone: () => ({ taskId, outcome: "interrupted", reply: Option.none(), failure: Option.some({ code: "task.deadline", message: "the task ran out of time" }) }),
    onSome: (done) => ({
      taskId, outcome: done.outcome, reply: done.reply,
      failure: done.outcome === "failed" ? Option.some({ code: "task.turn", message: "the task's turn failed" }) : Option.none(),
    }),
  }),
  onFailure: (cause) => {
    const error = Cause.squash(cause)
    return {
      taskId, outcome: "failed", reply: Option.none(),
      failure: Option.some(error instanceof HarnessError ? { code: error.code, message: error.message } : { code: "task.turn", message: "the task's turn failed" }),
    }
  },
})

/**
 * What the parent's inbox turn shows the model: a trusted frame around the
 * task's own words, which may not close the frame early.
 */
export const noticeOf = (task: TaskView, replyChars: number): string => {
  const output = Option.match(task.reply, {
    onNone: () => Option.match(task.failure, { onNone: () => "(no reply)", onSome: (failure) => `(no reply: ${failure.message})` }),
    onSome: (reply) => reply.length > replyChars ? `${reply.slice(0, replyChars)}\n(cut at ${replyChars} characters)` : reply,
  })
  return [`[Background task ${task.taskId} ${task.status}]`, "<task-output>", output.replaceAll("</task-output>", "</task_output>"), "</task-output>"].join("\n")
}
