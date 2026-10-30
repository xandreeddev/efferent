import type { Effect, Schema } from "effect"
import type { AssessmentError, EvaluationResult, EvaluationSplit, EvaluationUsage, LabelReview, Metric } from "./assessment.entity.js"
import type { EvaluationError } from "./domain/identity.entity.js"

/** @public */
export interface DatasetCase<I, Ref> {
  readonly id: string
  readonly family: string
  readonly split: typeof EvaluationSplit.Type
  readonly review: typeof LabelReview.Type
  readonly input: I
  readonly reference: Ref
  readonly provenance: string
}
/** @public */
export interface Dataset<I, Ref> {
  readonly id: string
  readonly version: string
  readonly input: Schema.Codec<I>
  readonly reference: Schema.Codec<Ref>
  readonly cases: ReadonlyArray<DatasetCase<I, Ref>>
}
/** @public */
export interface Assessment {
  readonly metrics: ReadonlyArray<Metric>
  readonly reason: string
  readonly references?: ReadonlyArray<string>
  readonly usage?: EvaluationUsage
  readonly metadata?: Schema.JsonObject
}
/**
 * A judging primitive: one run measures every metric it declares. It grades
 * a trial behind a grader (`graderFromEvaluator`). It fails with an
 * `AssessmentError` (a model call's: `assessmentOfAiError`) or an
 * `EvaluationError`; the grade keeps the code either way.
 */
export interface Evaluator<I, R = never> {
  readonly id: string
  readonly version: string
  /** A single execution may emit several independently selected metrics. */
  readonly metrics: ReadonlyArray<string>
  readonly run: (input: I) => Effect.Effect<Assessment, AssessmentError | EvaluationError, R>
}
/** @deprecated Put the evaluator behind a grader with `graderFromEvaluator`; the grader's `metrics` select what it keeps. */
export interface EvaluatorBinding<I, R = never> {
  readonly evaluator: Evaluator<I, R>
  readonly select: ReadonlyArray<string>
  readonly timeoutMs?: number
}
/** @public */
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
