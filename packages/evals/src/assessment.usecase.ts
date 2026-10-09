import type { Effect, Schema } from "effect"
import type { AssessmentError, EvaluationResult, EvaluationSplit, EvaluationUsage, LabelReview, Metric } from "./assessment.entity.js"

export interface DatasetCase<I, Ref> {
  readonly id: string
  readonly family: string
  readonly split: typeof EvaluationSplit.Type
  readonly review: typeof LabelReview.Type
  readonly input: I
  readonly reference: Ref
  readonly provenance: string
}
export interface Dataset<I, Ref> {
  readonly id: string
  readonly version: string
  readonly input: Schema.Codec<I>
  readonly reference: Schema.Codec<Ref>
  readonly cases: ReadonlyArray<DatasetCase<I, Ref>>
}
export interface Assessment {
  readonly metrics: ReadonlyArray<Metric>
  readonly reason: string
  readonly references?: ReadonlyArray<string>
  readonly usage?: EvaluationUsage
  readonly metadata?: Readonly<Record<string, unknown>>
}
export interface Evaluator<I, R = never> {
  readonly id: string
  readonly version: string
  /** A single execution may emit several independently selected metrics. */
  readonly metrics: ReadonlyArray<string>
  readonly run: (input: I) => Effect.Effect<Assessment, AssessmentError, R>
}
export interface EvaluatorBinding<I, R = never> {
  readonly evaluator: Evaluator<I, R>
  readonly select: ReadonlyArray<string>
  readonly timeoutMs?: number
}
export interface AssessmentInput<I, O, E, Ref> {
  readonly input: I
  readonly output: O
  readonly evidence: E
  readonly reference: Ref
}
export interface SavedAssessment<I> {
  readonly input: I
  readonly results: ReadonlyArray<EvaluationResult>
}
