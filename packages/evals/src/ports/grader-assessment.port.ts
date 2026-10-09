import { Context } from "effect"
import type { Effect } from "effect"
import type { Candidate } from "../domain/candidate.entity.js"
import type { Grade } from "../domain/grader.entity.js"
import type { GradingContext } from "../domain/grading-context.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"

export class GraderAssessment extends Context.Service<
  GraderAssessment,
  {
    readonly assess: (
      context: GradingContext,
      candidate: Candidate
    ) => Effect.Effect<
      Omit<
        Grade,
        "grader" | "version" | "scope" | "context" | "startedAt" | "endedAt"
      >,
      EvaluationError
    >
  }
>()("efferent/evals/GraderAssessment") {}
