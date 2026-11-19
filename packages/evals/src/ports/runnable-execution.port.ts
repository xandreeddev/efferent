import { Context } from "effect"
import type { Effect } from "effect"
import type { Candidate } from "../domain/candidate.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"
import type { ModelSpend } from "@xandreed/core"
import type { TrialRecorder } from "./trial-recorder.port.js"

/**
 * Each application creates a port for its specific input, result and live world.
 * `execute` reads the trial's `TrialRecorder`, and the `ModelSpend` ledger
 * its model sends reserve in: its account in the run's ledger, within the
 * run's budget (pass it to the agents or clients the trial runs).
 *
 * @public
 */
export interface RunnableExecution<I, O, E, W> {
  readonly execute: (
    input: I,
    candidate: Candidate,
    environment: W
  ) => Effect.Effect<
    { readonly output: O; readonly evidence: E },
    EvaluationError,
    TrialRecorder | ModelSpend
  >
}

export const runnableExecutionPort = <I, O, E, W>(id: string) =>
  Context.Service<RunnableExecution<I, O, E, W>>(`efferent/evals/${id}/RunnableExecution`)
