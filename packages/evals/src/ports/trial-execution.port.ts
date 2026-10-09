import { Context } from "effect"
import type { Effect, Schema, Scope } from "effect"
import type { Candidate } from "../domain/candidate.entity.js"
import type { Outcome } from "../domain/outcome.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"
import type { TrialRecorder } from "./trial-recorder.port.js"

/** Portable boundary of a typed runnable/environment pair. Live worlds never cross it. */
export class TrialExecution extends Context.Service<TrialExecution, {
  readonly execute: (
    input: Schema.Json,
    candidate: Candidate,
    inspection: {
      readonly timeoutMs: number
      readonly record: (outcome: Outcome) => Effect.Effect<void>
    }
  ) => Effect.Effect<
    { readonly output: Schema.Json; readonly evidence: Schema.Json },
    EvaluationError,
    TrialRecorder | Scope.Scope
  >
}>()("efferent/evals/TrialExecution") {}
