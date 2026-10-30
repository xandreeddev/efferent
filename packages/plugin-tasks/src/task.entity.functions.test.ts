import { describe, expect, test } from "bun:test"
import { Effect, Exit, Option } from "effect"
import { ConversationId, HarnessError, SessionContended } from "@xandreed/core"
import type { JsonObject, SessionLogEvent, TaskView, TurnError, TurnOutcome } from "@xandreed/core"
import { deliveredOf, noticeOf, resultOf } from "./task.entity.functions.js"
import { tasksDefaults } from "./task-records.entity.js"

const session = ConversationId.make("00000000-0000-4000-8000-00000000b4b4")
const event = (seq: number, kind: string, data: JsonObject): SessionLogEvent => ({ session, seq, turn: Option.none(), kind, at: 0, data })

test("the inbox ids delivered are the inbox.queued records' ids; one that does not decode fails with session.decode", async () => {
  const delivered = await Effect.runPromise(deliveredOf([
    event(1, "inbox.queued", { id: "task:a", source: { kind: "task" }, content: "done" }),
    event(2, "task.started", { taskId: "b" }),
    event(3, "inbox.queued", { id: "task:c", source: {}, content: "" }),
  ]))
  expect([...delivered]).toEqual(["task:a", "task:c"])
  const broken = await Effect.runPromise(Effect.flip(deliveredOf([event(1, "inbox.queued", { id: 5, source: {}, content: "done" })])))
  expect([broken._tag, broken.code]).toEqual(["SessionLogError", "session.decode"])
})

describe("the notice of a task that ends without a reply", () => {
  const taskId = ConversationId.make("00000000-0000-4000-8000-00000000b4b5")
  /** The notice the parent's model reads for a task whose turn ended so. */
  const noticeAfter = (exit: Exit.Exit<Option.Option<TurnOutcome>, TurnError>): string => {
    const result = resultOf(taskId, exit)
    const task: TaskView = {
      taskId, parent: session, child: taskId, instructions: "look it up", mode: "spawn",
      status: result.outcome, reply: result.reply, failure: result.failure, delivered: false,
    }
    return noticeOf(task, tasksDefaults.replyChars)
  }
  const frame = (status: string, output: string) => `[Background task ${taskId} ${status}]\n<task-output>\n${output}\n</task-output>`

  test("says why: no reply at all, the deadline, a failed turn, a failure without a framework code, a tag's code, a HarnessError's own message", () => {
    expect([
      noticeAfter(Exit.succeed(Option.some({ outcome: "completed", reply: Option.none() }))),
      noticeAfter(Exit.succeed(Option.none())),
      noticeAfter(Exit.succeed(Option.some({ outcome: "failed", reply: Option.none() }))),
      noticeAfter(Exit.die(new Error("disk on fire"))),
      noticeAfter(Exit.fail(new SessionContended({ session, attempts: 3 }))),
      noticeAfter(Exit.fail(new HarnessError({ code: "model.down", message: "the model is unavailable" }))),
    ]).toEqual([
      frame("completed", "(no reply)"),
      frame("interrupted", "(no reply: the task ran out of time)"),
      frame("failed", "(no reply: the task's turn failed)"),
      frame("failed", "(no reply: the task's turn failed)"),
      frame("failed", "(no reply: the task's session was too busy: its writes kept conflicting with others)"),
      frame("failed", "(no reply: the model is unavailable)"),
    ])
  })
})
