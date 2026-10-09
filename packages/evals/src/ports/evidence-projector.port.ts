import { Context } from "effect"
import type { Effect } from "effect"
import type { Trial } from "../domain/trial.entity.js"
import type { Task } from "../domain/task.entity.js"
import type { GradingContext } from "../domain/grading-context.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"

export class EvidenceProjector extends Context.Service<
  EvidenceProjector,
  {
    readonly project: (
      trial: Trial,
      task: Task,
      scope: string
    ) => Effect.Effect<GradingContext, EvaluationError>
  }
>()("efferent/evals/EvidenceProjector") {}
