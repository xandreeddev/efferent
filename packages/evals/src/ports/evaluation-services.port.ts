import { Context } from "effect"
import type { Effect, Option, Scope } from "effect"
import type { ModelSpend, SpendAmount, SpendTotals } from "@xandreed/core"
import type { EvaluationError } from "../domain/identity.entity.js"
import type { TrialSpend } from "../domain/spend.entity.js"
import type { TrialExecution } from "./trial-execution.port.js"
import type { EvidenceProjector } from "./evidence-projector.port.js"
import type { GraderAssessment } from "./grader-assessment.port.js"
import type { TrialRecorder } from "./trial-recorder.port.js"

/**
 * One trial's account in its run's spend ledger.
 *
 * @public
 */
export interface TrialSpendAccount {
  /**
   * The `ModelSpend` ledger the trial's runnable reserves its model sends
   * in: the run's ledger, every reservation's total cap no higher than the
   * run's budget, with what the trial settles kept apart.
   */
  readonly ledger: ModelSpend["Service"]
  /** What the trial has settled; none while it has reserved nothing. */
  readonly spend: Effect.Effect<Option.Option<TrialSpend>>
  /** The refusal under the ledger's total cap that stopped one of the trial's sends, if one did. */
  readonly refusal: Effect.Effect<Option.Option<string>>
}

/**
 * The spend ledger one run's trials share, open for the run's scope.
 *
 * @public
 */
export interface RunSpendLedger {
  /** What every trial has settled and still holds. */
  readonly totals: Effect.Effect<SpendTotals, EvaluationError>
  /**
   * Why the run starts no more trials, once it may spend no more: the
   * ledger's total cap refused a send, or what was settled reached the
   * budget; none while it may spend.
   */
  readonly stopped: Effect.Effect<Option.Option<string>, EvaluationError>
  /** A fresh account for one trial. */
  readonly trial: Effect.Effect<TrialSpendAccount>
}

/**
 * Resolves registrations into fresh services inside the caller's trial/grade scope.
 *
 * @public
 */
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
    /**
     * The run's spend ledger, empty, in the caller's (the run's) scope: its
     * trials reserve their model sends in it, within `budget` when one is
     * given.
     */
    readonly spend: (
      budget: Option.Option<SpendAmount>
    ) => Effect.Effect<RunSpendLedger, EvaluationError, Scope.Scope>
  }
>()("efferent/evals/EvaluationServices") {}
