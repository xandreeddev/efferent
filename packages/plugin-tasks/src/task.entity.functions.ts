import { Cause, Effect, Exit, Match, Option, Schema } from "effect"
import { clipTo, framed, harnessCodeOf, InboxItemId, isTurnError, readStored, SessionLogError } from "@xandreed/core"
import type { SessionLogEvent, SessionView, TaskStatus, TaskView, TurnClosed, TurnError, TurnFailure, TurnOutcome } from "@xandreed/core"
import { TASK_CANCELLED, TASK_RESULT, TASK_STARTED, TaskOutcome, TaskResult, TaskStarted } from "./task-records.entity.js"
import type { TaskResult as Result, TaskStarted as Started } from "./task-records.entity.js"
import { initialStarted, latestQuestionOf, outstandingOf } from "./task-controls.entity.functions.js"

const decodeStarted = Schema.decodeUnknownOption(TaskStarted)
const decodeResult = Schema.decodeUnknownOption(TaskResult)

/** The inbox id a task's result is delivered under: once per task. */
export const deliveryId = (taskId: string): InboxItemId => InboxItemId.make(`task:${taskId}`)

const FINISHED: ReadonlyArray<TaskStatus> = TaskOutcome.literals

/** Done and worth telling the parent about (a cancelled task tells nothing). */
export const isFinished = (status: TaskStatus): boolean => FINISHED.includes(status)

/** Waiting to run, or running. */
export const isActive = (status: TaskStatus): boolean => status === "pending" || status === "running" || status === "waiting"

/** The tasks a parent started, in order; a record that does not decode is skipped. */
export const startedOf = (events: ReadonlyArray<SessionLogEvent>): ReadonlyArray<Started> =>
  events.filter((event) => event.kind === TASK_STARTED).flatMap((event) => Option.toArray(decodeStarted(event.data)))

/** The inbox ids a session has had delivered; an `inbox.queued` record that does not decode fails with `session.decode`. */
export const deliveredOf = (events: ReadonlyArray<SessionLogEvent>): Effect.Effect<ReadonlySet<string>, SessionLogError> => readStored("inbox.queued", events).pipe(
  Effect.map((queued) => new Set(queued.map((item) => item.data.id))),
  Effect.mapError((error) => new SessionLogError({ code: "session.decode", message: error.message, cause: error })))

export interface TaskEnd {
  readonly status: TaskStatus
  readonly reply: Option.Option<string>
  readonly failure: Option.Option<TurnFailure>
  readonly question?: NonNullable<TaskView["question"]>
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
  const question = outstandingOf(records)
  if (Option.isSome(question)) return { status: "waiting", reply: Option.none(), failure: Option.none(), question: question.value }
  if (Option.isSome(view.open)) return { status: "running", reply: Option.none(), failure: Option.none() }
  if (Option.isSome(latestQuestionOf(records)) || view.pending > 0) return { status: "pending", reply: Option.none(), failure: Option.none() }
  if (records.some((event) => event.kind === "turn.started") && !initialStarted(records, view.header.id)) return { status: "pending", reply: Option.none(), failure: Option.none() }
  return began(view)
    ? { status: "interrupted", reply: Option.none(), failure: Option.some({ code: "task.lost", message: "the task's turn stopped without a result" }) }
    : { status: "pending", reply: Option.none(), failure: Option.none() }
}

/** Whether a session is a task's own: its child, forked by a start (origin `task`). A task's session starts no task. */
export const isTaskSession = (view: SessionView): boolean => view.header.origin === "task"

/** Whether a session is a task child of `parent`: forked from it by a start, not another session under the task's id. */
export const isChildOf = (view: SessionView, parent: string): boolean =>
  isTaskSession(view) && Option.exists(view.header.parent, (lineage) => lineage.id === parent)

/** A child that no longer exists: its parent's removal took it. */
export const goneEnd: TaskEnd = { status: "cancelled", reply: Option.none(), failure: Option.some({ code: "task.removed", message: "the task's session was removed" }) }

/** Why a task's turn closed, in the parent model's words. */
const closedText: Readonly<Record<TurnClosed["reason"], string>> = {
  cancelled: "the task's turn was cancelled",
  interrupted: "the task's turn was interrupted",
  removed: "the task's session was removed",
  "timed-out": "the task's turn ran past its time limit",
  ended: "the task's turn had already ended",
}

/**
 * A turn's failure as the parent model reads it: a `HarnessError`'s own
 * message, the other tags in words. Never a tag's name or a store's message.
 */
const failureText = (error: TurnError): string => Match.valueTags(error, {
  HarnessError: (harness) => harness.message,
  TurnClosed: (closed) => closedText[closed.reason],
  ReservedKind: () => "the task's turn tried to record an event only the framework records",
  SessionContended: () => "the task's session was too busy: its writes kept conflicting with others",
  SessionLogError: () => "the task's session could not be read or stored",
})

/**
 * How the child's turn went, as its result records it: a turn past its
 * deadline is interrupted; a failed one stores its error's framework code
 * (`harnessCodeOf`: a `HarnessError`'s own, carried as a defect included, or
 * the code a tag such as `TurnClosed` stands for), else `task.turn`, and
 * what went wrong in words (`failureText`).
 */
export const resultOf = (taskId: Result["taskId"], exit: Exit.Exit<Option.Option<Omit<TurnOutcome, "outcome"> & { readonly outcome: Result["outcome"] }>, TurnError>): Result => Exit.match(exit, {
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
      failure: Option.some(Option.match(harnessCodeOf(error), {
        onNone: () => ({ code: "task.turn", message: "the task's turn failed" }),
        onSome: (code) => ({ code, message: isTurnError(error) ? failureText(error) : "the task's turn failed" }),
      })),
    }
  },
})

/** Where a task stands, in the words of its notice's first line, never the status's name. */
const statusText: Readonly<Record<TaskStatus, string>> = {
  pending: "has not started yet",
  running: "is still running",
  waiting: "needs your answer",
  completed: "completed",
  partial: "stopped before it finished",
  failed: "failed",
  cancelled: "was cancelled",
  interrupted: "was interrupted",
}

/**
 * What the parent's inbox turn shows the model: how the task ended, in
 * words, then a trusted frame around the task's own words, which may not
 * close or reopen the frame (in any case or spacing), clipped to
 * `replyChars` with a counted marker (`clipTo`).
 */
export const noticeOf = (task: TaskView, replyChars: number): string => {
  const output = Option.match(task.reply, {
    onNone: () => Option.match(task.failure, { onNone: () => "(no reply)", onSome: (failure) => `(no reply: ${failure.message})` }),
    onSome: (reply) => clipTo(reply, replyChars),
  })
  return [`[Background task ${task.taskId} ${statusText[task.status]}]`, framed("task-output", output)].join("\n")
}
