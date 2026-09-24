import type { Effect, Schema } from "effect"
import type { AssessmentError } from "./assessment.entity.js"
import type { Benchmark, Dataset, Evaluator } from "./assessment.usecase.js"

export interface EvaluatorRegistration<I, R = never> {
  readonly id: string
  readonly version: string
  readonly projectionVersion: string
  readonly promptHash: string
  readonly settings: Readonly<Record<string, unknown>>
  readonly evaluator: Evaluator<I, R>
}
/** Exactly one subject execution; reference labels are supplied only to the comparator. */
export interface PromptFamily<I, O, Ref, R = never> {
  readonly id: string
  readonly version: string
  readonly output: Schema.Schema<O>
  readonly dataset: Dataset<I, Ref>
  readonly evaluate: (input: I) => Effect.Effect<O, AssessmentError, R>
  readonly comparator: Benchmark<I, O, O, Ref, R>["evaluators"]
}
