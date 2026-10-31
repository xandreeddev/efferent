import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { ConversationId } from "../domain/message.entity.js"
import { RunId, RunOrdinal } from "../domain/run.entity.js"
import { TaskQuestion, TaskQuestionId } from "./task-question.entity.js"
import { TaskView } from "./tasks.entity.js"

const question: TaskQuestion = {
  questionId: TaskQuestionId.make("question-1"),
  text: "Which source should I inspect?",
  askedBy: { run: { id: RunId.make("asking-run"), turn: 2, ordinal: RunOrdinal.make(3) }, step: 4 },
}

describe("task question contracts", () => {
  test("questions retain the full run occurrence and require a nonempty stable id, text and nonnegative step", () => {
    const decode = Schema.decodeUnknownOption(TaskQuestion)
    expect(decode(question)).toEqual(Option.some(question))
    expect(decode({ ...question, questionId: "" })).toEqual(Option.none())
    expect(decode({ ...question, text: "" })).toEqual(Option.none())
    expect(decode({ ...question, askedBy: { ...question.askedBy, step: -1 } })).toEqual(Option.none())
    expect(decode({ ...question, askedBy: { run: { id: "asking-run", turn: 2 }, step: 4 } })).toEqual(Option.none())
  })

  test("the optional outstanding question preserves older task views", () => {
    const id = ConversationId.make("00000000-0000-4000-8000-000000000001")
    const task = { taskId: id, parent: id, child: id, instructions: "inspect", mode: "spawn", status: "waiting", reply: null, failure: null, delivered: false } as const
    expect(Option.isSome(Schema.decodeUnknownOption(TaskView)(task))).toBe(true)
    expect(Schema.decodeUnknownOption(TaskView)({ ...task, question })).toEqual(Option.some({ ...task, reply: Option.none(), failure: Option.none(), question }))
  })
})
