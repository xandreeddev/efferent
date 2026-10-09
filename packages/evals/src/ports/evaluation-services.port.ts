import { Context } from "effect"
import type { Effect, Scope } from "effect"
import type { EvaluationError } from "../domain/identity.entity.js"
import type { TrialExecution } from "./trial-execution.port.js"
import type { EvidenceProjector } from "./evidence-projector.port.js"
import type { GraderAssessment } from "./grader-assessment.port.js"
import type { TrialRecorder } from "./trial-recorder.port.js"

/** Resolves registrations into fresh services inside the caller's trial/grade scope. */
export class EvaluationServices extends Context.Service<
  EvaluationServices,
  {
    readonly execution: (
      runnable: string,
      environment: string,
      recorder: TrialRecorder["Service"]
    ) => Effect.Effect<
      Context.Context<
        TrialExecution | TrialRecorder
      >,
      EvaluationError,
      Scope.Scope
    >
    readonly projection: (
      id: string
    ) => Effect.Effect<
      Context.Context<EvidenceProjector>,
      EvaluationError,
      Scope.Scope
    >
    readonly grading: (
      id: string
    ) => Effect.Effect<
      Context.Context<GraderAssessment>,
      EvaluationError,
      Scope.Scope
    >
  }
>()("efferent/evals/EvaluationServices") {}
