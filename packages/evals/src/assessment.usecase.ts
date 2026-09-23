import type { Effect, Schema, Scope } from "effect"
import type { AssessmentError, EvaluationResult, EvaluationSplit, EvaluationTrial, EvaluationUsage, LabelReview, Metric } from "./assessment.entity.js"

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
  readonly input: Schema.Schema<I>
  readonly reference: Schema.Schema<Ref>
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
export interface Benchmark<I, O, E, Ref, R = never> {
  readonly id: string
  readonly kind: "benchmark" | "journey"
  readonly dataset: Dataset<I, Ref>
  readonly output: Schema.Schema<O>
  readonly evidence: Schema.Schema<E>
  /** References are intentionally absent from the task's arguments. */
  readonly task: (input: I) => Effect.Effect<{ readonly output: O; readonly evidence: E }, AssessmentError, R | Scope.Scope>
  readonly evaluators: ReadonlyArray<EvaluatorBinding<AssessmentInput<I, O, E, Ref>, R>>
}
export interface BenchmarkOptions {
  readonly candidate: Readonly<Record<string, unknown>>
  readonly split: typeof EvaluationSplit.Type
  readonly repetitions: number
  readonly concurrency?: number
  readonly timeoutMs?: number
  readonly runId: string
}
export interface BoundEvaluation<R = never> {
  readonly id: string
  readonly kind: "benchmark" | "journey"
  readonly run: (options: BenchmarkOptions) => Effect.Effect<ReadonlyArray<EvaluationTrial>, AssessmentError, R>
}
export interface EvaluationReporter<R = never> {
  readonly id: string
  readonly write: (trials: ReadonlyArray<EvaluationTrial>) => Effect.Effect<void, AssessmentError, R>
}
export interface Gate {
  readonly evaluator: string
  readonly metric: string
  readonly minimum: number
  readonly mode: "blocking" | "diagnostic"
  readonly requiresReviewedReference?: boolean
}
export interface GateResult {
  readonly passed: boolean
  readonly findings: ReadonlyArray<string>
}
export interface SavedAssessment<I> {
  readonly input: I
  readonly results: ReadonlyArray<EvaluationResult>
}
