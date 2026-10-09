import { Context } from "effect"
import type { Effect } from "effect"
import type { Candidate } from "../domain/candidate.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"
import type { TrialRecorder } from "./trial-recorder.port.js"

/** Each application creates a port for its specific input, result and live world. */
export interface RunnableExecution<I, O, E, W> {
  readonly execute: (
    input: I,
    candidate: Candidate,
    environment: W
  ) => Effect.Effect<
    { readonly output: O; readonly evidence: E },
    EvaluationError,
    TrialRecorder
  >
}

export const runnableExecutionPort = <I, O, E, W>(id: string) =>
  Context.Service<RunnableExecution<I, O, E, W>>(`efferent/evals/${id}/RunnableExecution`)
