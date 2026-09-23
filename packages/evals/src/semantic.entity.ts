import { Schema } from "effect"
import { EvaluationUsage } from "./assessment.entity.js"

export const SemanticQuestion = Schema.Union(
  Schema.Struct({ type: Schema.Literal("boolean"), instructions: Schema.NonEmptyTrimmedString }),
  Schema.Struct({ type: Schema.Literal("score"), instructions: Schema.NonEmptyTrimmedString,
    criteria: Schema.Array(Schema.NonEmptyTrimmedString).pipe(Schema.minItems(2)) }),
  Schema.Struct({ type: Schema.Literal("choice"), instructions: Schema.NonEmptyTrimmedString,
    criteria: Schema.Record({ key: Schema.NonEmptyTrimmedString, value: Schema.NonEmptyTrimmedString }).pipe(Schema.filter((values) => Object.keys(values).length > 0)) }),
)
export type SemanticQuestion = typeof SemanticQuestion.Type
export const SemanticQuestions = Schema.Record({ key: Schema.NonEmptyTrimmedString, value: SemanticQuestion }).pipe(Schema.filter((values) => Object.keys(values).length > 0))
export type SemanticQuestions = typeof SemanticQuestions.Type
export const SemanticAnswer = Schema.Union(
  Schema.Struct({ type: Schema.Literal("boolean"), probability: Schema.Number.pipe(Schema.finite(), Schema.between(0, 1)) }),
  Schema.Struct({ type: Schema.Literal("score"), score: Schema.Number.pipe(Schema.finite(), Schema.nonNegative()) }),
  Schema.Struct({ type: Schema.Literal("choice"), choice: Schema.NonEmptyString }),
)
export type SemanticAnswer = typeof SemanticAnswer.Type
export const SemanticAnswers = Schema.Record({ key: Schema.NonEmptyTrimmedString, value: SemanticAnswer })
export type SemanticAnswers = typeof SemanticAnswers.Type
export const SemanticInput = Schema.Struct({ state: Schema.String, questions: SemanticQuestions })
export type SemanticInput = typeof SemanticInput.Type
export const SemanticResult = Schema.Struct({
  answers: SemanticAnswers,
  usage: EvaluationUsage,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
})
export type SemanticResult = typeof SemanticResult.Type
