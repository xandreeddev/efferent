import type { Evaluator } from "./assessment.usecase.js"

/**
 * A versioned evaluator or judge an application offers to its calibrations and journeys.
 * @deprecated Register the evaluator as a grader (`graderFromEvaluator`) in the app's `graders`; a task binds it as `<id>@<version>`.
 */
export interface EvaluatorRegistration<I, R = never> {
  readonly id: string
  readonly version: string
  readonly projectionVersion: string
  readonly promptHash: string
  readonly settings: Readonly<Record<string, unknown>>
  readonly evaluator: Evaluator<I, R>
}
