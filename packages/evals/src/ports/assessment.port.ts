import { Context } from "effect"
import type { Effect } from "effect"
import type { AssessmentError, EvaluationResult, EvaluationTrial } from "../assessment.entity.js"

/** Durable evidence is required even when no remote reporter is configured. */
export class EvaluationStore extends Context.Tag("efferent/evals/EvaluationStore")<EvaluationStore, {
  readonly writeTrial: (trial: EvaluationTrial) => Effect.Effect<void, AssessmentError>
  readonly writeAssessment: (trialId: string, result: EvaluationResult) => Effect.Effect<void, AssessmentError>
}>() {}
