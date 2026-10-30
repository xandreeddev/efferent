import { Effect, Option } from "effect"
import type { AssessmentError } from "./assessment.entity.js"
import type { Evaluator } from "./assessment.usecase.js"
import type { EvaluationError } from "./domain/identity.entity.js"

export const unknownEvaluationUsage = { inputTokens: Option.none<number>(), outputTokens: Option.none<number>(), costUsd: Option.none<number>() }

/**
 * Adapts a narrow evaluator without exposing the parent evidence bundle to it.
 *
 * @public
 */
export const projectEvaluatorInput = <Whole, Input, R, P = never>(evaluator: Evaluator<Input, R>, project: (whole: Whole) => Effect.Effect<Input, AssessmentError | EvaluationError, P>): Evaluator<Whole, R | P> => ({
  ...evaluator, run: (whole) => project(whole).pipe(Effect.flatMap(evaluator.run)),
})
