import type { Effect, Layer } from "effect"
import type { Suite } from "../domain/suite.entity.js"
import type { Runnable } from "../domain/runnable.entity.js"
import type { Grader } from "../domain/grader.entity.js"
import type { Calibration } from "../domain/calibration.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"

import type { EvidenceProjection } from "../domain/evidence-projection.entity.js"
import type { TrialExecution } from "../ports/trial-execution.port.js"
import type { EvidenceProjector } from "../ports/evidence-projector.port.js"
import type { GraderAssessment } from "../ports/grader-assessment.port.js"
import type { EvaluationExport } from "../ports/evaluation-export.port.js"

/** Registrations are static metadata and dependency layers, never executable callbacks. */
export interface RunnableRegistration {
  readonly definition: Runnable
  readonly environments: ReadonlyArray<EnvironmentRegistration>
}
export interface EnvironmentRegistration {
  readonly id: string
  readonly layer: Layer.Layer<TrialExecution, EvaluationError>
}
export interface ProjectionRegistration {
  readonly definition: EvidenceProjection
  readonly layer: Layer.Layer<EvidenceProjector, EvaluationError>
}
export interface GraderRegistration {
  readonly definition: Grader
  readonly layer: Layer.Layer<GraderAssessment, EvaluationError>
}
export interface ExporterRegistration {
  readonly id: string
  readonly layer: Layer.Layer<EvaluationExport, EvaluationError>
}
export interface EvaluationApp {
  readonly id: string
  readonly suites: ReadonlyArray<Suite>
  readonly calibrations: ReadonlyArray<Calibration>
  readonly runnables: ReadonlyArray<RunnableRegistration>
  readonly graders: ReadonlyArray<GraderRegistration>
  readonly projections: ReadonlyArray<ProjectionRegistration>
  readonly environmentFor: Readonly<Record<string, string>>
  readonly fingerprints: Readonly<Record<string, string>>
  readonly exporters?: ReadonlyArray<ExporterRegistration>
  readonly commands: Readonly<
    Record<
      string,
      (args: ReadonlyArray<string>) => Effect.Effect<unknown, EvaluationError>
    >
  >
}
export interface EvaluationSelection {
  readonly ids: ReadonlyArray<string>
  readonly split: string
  readonly repetitions?: number
  readonly environment?: string
  readonly candidates?: ReadonlyArray<string>
  readonly tasks?: ReadonlyArray<string>
  readonly executeOnly?: boolean
  readonly concurrency?: number
  readonly timeoutMs?: number
}
export interface GradingSelection {
  readonly graders?: ReadonlyArray<string>
}
