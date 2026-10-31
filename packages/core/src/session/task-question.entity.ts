import { Schema } from "effect"
import { RunRef } from "../domain/run.entity.js"

/** A stable question identity supplied by its host or derived from one durable tool invocation. */
export const TaskQuestionId = Schema.Trimmed.check(Schema.isNonEmpty()).pipe(Schema.brand("TaskQuestionId"))
export type TaskQuestionId = typeof TaskQuestionId.Type

/** A helper's accepted question and the exact loop occurrence which asked it. */
export const TaskQuestion = Schema.Struct({
  questionId: TaskQuestionId,
  text: Schema.NonEmptyString,
  askedBy: Schema.Struct({ run: RunRef, step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
})
export type TaskQuestion = typeof TaskQuestion.Type
