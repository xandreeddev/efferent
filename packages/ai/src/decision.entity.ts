import { Schema } from "effect"
import type { Option } from "effect"
import type { PromptId, PromptProvenance } from "@xandreed/core"
import type { Variants } from "./prompt.entity.js"

export const Probability = Schema.Number.pipe(Schema.check(Schema.isFinite()), Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })))

/** Choose one of the offered criteria (keys are the choices, values describe them). */
export const ChoiceQuestion = Schema.Struct({
  type: Schema.Literal("choice"),
  instructions: Schema.Trimmed.check(Schema.isNonEmpty()),
  criteria: Schema.Record(Schema.Trimmed.check(Schema.isNonEmpty()), Schema.Trimmed.check(Schema.isNonEmpty())),
})
export type ChoiceQuestion = typeof ChoiceQuestion.Type

/** How likely the statement in the instructions holds. */
export const BooleanQuestion = Schema.Struct({
  type: Schema.Literal("boolean"),
  instructions: Schema.Trimmed.check(Schema.isNonEmpty()),
})
export type BooleanQuestion = typeof BooleanQuestion.Type

export const DecisionQuestion = Schema.Union([ChoiceQuestion, BooleanQuestion])
export type DecisionQuestion = typeof DecisionQuestion.Type
export const DecisionQuestions = Schema.Record(Schema.Trimmed.check(Schema.isNonEmpty()), DecisionQuestion)
export type DecisionQuestions = typeof DecisionQuestions.Type

export const ChoiceAnswer = Schema.TaggedStruct("choice", {
  choice: Schema.NonEmptyString,
  confidence: Schema.Option(Probability),
})
export type ChoiceAnswer = typeof ChoiceAnswer.Type
export const BooleanAnswer = Schema.TaggedStruct("boolean", { probability: Probability })
export type BooleanAnswer = typeof BooleanAnswer.Type
export const DecisionAnswer = Schema.Union([ChoiceAnswer, BooleanAnswer])
export type DecisionAnswer = typeof DecisionAnswer.Type
export const DecisionAnswers = Schema.Record(Schema.String, DecisionAnswer)
export type DecisionAnswers = typeof DecisionAnswers.Type

/** One answer as an evaluation transport returns it. */
export const WireAnswer = Schema.Union(
  [Schema.Struct({ type: Schema.Literal("choice"), choice: Schema.NonEmptyString, confidence: Schema.optional(Probability) }),
  Schema.Struct({ type: Schema.Literal("boolean"), probability: Probability })],
)
export type WireAnswer = typeof WireAnswer.Type
export const WireAnswers = Schema.Record(Schema.String, WireAnswer)
export type WireAnswers = typeof WireAnswers.Type

/** The answers to exactly these questions: a choice answer per choice question, a probability per boolean one. */
export type AnswersOf<Q extends DecisionQuestions> = {
  readonly [K in keyof Q]: Q[K] extends ChoiceQuestion ? ChoiceAnswer : BooleanAnswer
}

/** One variant's wording of a question: its instructions, and the descriptions of choices it offers. */
export interface QuestionOverride {
  readonly instructions?: string
  readonly criteria?: Readonly<Record<string, string>>
}

/** A variant's fragment of a decision prompt: wording by question id. */
export type QuestionOverrides = Readonly<Record<string, QuestionOverride>>

/**
 * A decision asked of an evaluation model, with an identity: the state
 * (data, never instructions) and the questions come from the input; a
 * variant rewords questions, never what they offer.
 */
export interface DecisionPrompt<I, Q extends DecisionQuestions> {
  readonly _tag: "DecisionPrompt"
  readonly id: typeof PromptId.Type
  readonly version: string
  /** The decision family records and metrics group by (e.g. `skill-selection`). */
  readonly family: string
  readonly state: (input: I) => string | Readonly<Record<string, unknown>>
  readonly questions: (input: I) => Q
  readonly variants: Option.Option<Variants<QuestionOverrides>>
}

/** A decision as asked: the state as text, the questions as worded, and the provenance. */
export interface RenderedDecision<Q extends DecisionQuestions = DecisionQuestions> {
  readonly state: string
  readonly questions: Q
  readonly family: string
  readonly provenance: PromptProvenance
}

export class EvaluationError extends Schema.TaggedError<EvaluationError>()("EvaluationError", {
  code: Schema.Literals(["unavailable", "timeout", "invalid", "budget"]),
  message: Schema.String,
}) {}
