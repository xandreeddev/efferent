import { Context } from "effect"
import type { Effect } from "effect"
import type { Trial } from "../domain/trial.entity.js"
import type { EvaluationRun } from "../domain/evaluation-run.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"

export class EvaluationRunStore extends Context.Service<EvaluationRunStore, {
  readonly writeTrial: (trial: Trial) => Effect.Effect<void, EvaluationError>
  readonly writeRun: (run: EvaluationRun) => Effect.Effect<void, EvaluationError>
}>()("efferent/evals/EvaluationRunStore") {}
