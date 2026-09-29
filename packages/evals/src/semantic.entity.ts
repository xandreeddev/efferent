import { Schema } from "effect"
import { EvaluationUsage } from "./assessment.entity.js"

export const SemanticQuestion = Schema.Union(
  [Schema.Struct({ type: Schema.Literal("boolean"), instructions: Schema.Trimmed.check(Schema.isNonEmpty()) }),
  Schema.Struct({ type: Schema.Literal("score"), instructions: Schema.Trimmed.check(Schema.isNonEmpty()),
    criteria: Schema.Array(Schema.Trimmed.check(Schema.isNonEmpty())).pipe(Schema.check(Schema.isMinLength(2))) }),
  Schema.Struct({ type: Schema.Literal("choice"), instructions: Schema.Trimmed.check(Schema.isNonEmpty()),
    criteria: Schema.Record(Schema.Trimmed.check(Schema.isNonEmpty()), Schema.Trimmed.check(Schema.isNonEmpty())).check(Schema.makeFilter((values) => Object.keys(values).length > 0)) })],
)
export type SemanticQuestion = typeof SemanticQuestion.Type
export const SemanticQuestions = Schema.Record(Schema.Trimmed.check(Schema.isNonEmpty()), SemanticQuestion).check(Schema.makeFilter((values) => Object.keys(values).length > 0))
export type SemanticQuestions = typeof SemanticQuestions.Type
export const SemanticAnswer = Schema.Union(
  [Schema.Struct({ type: Schema.Literal("boolean"), probability: Schema.Number.pipe(Schema.check(Schema.isFinite()), Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))) }),
  Schema.Struct({ type: Schema.Literal("score"), score: Schema.Number.pipe(Schema.check(Schema.isFinite()), Schema.check(Schema.isGreaterThanOrEqualTo(0))) }),
  Schema.Struct({ type: Schema.Literal("choice"), choice: Schema.NonEmptyString })],
)
export type SemanticAnswer = typeof SemanticAnswer.Type
export const SemanticAnswers = Schema.Record(Schema.Trimmed.check(Schema.isNonEmpty()), SemanticAnswer)
export type SemanticAnswers = typeof SemanticAnswers.Type
export const SemanticInput = Schema.Struct({ state: Schema.String, questions: SemanticQuestions })
export type SemanticInput = typeof SemanticInput.Type
export const SemanticResult = Schema.Struct({
  answers: SemanticAnswers,
  usage: EvaluationUsage,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
})
export type SemanticResult = typeof SemanticResult.Type
