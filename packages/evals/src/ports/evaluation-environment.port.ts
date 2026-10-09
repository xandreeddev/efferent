import { Context } from "effect"
import type { Effect, Scope } from "effect"
import type { Candidate } from "../domain/candidate.entity.js"
import type { Outcome } from "../domain/outcome.entity.js"
import type { EvaluationError } from "../domain/identity.entity.js"

/** The world produced by this port must be the world required by its runnable. */
export interface EvaluationEnvironment<I, W> {
  readonly open: (input: I, candidate: Candidate) => Effect.Effect<W, EvaluationError, Scope.Scope>
  readonly inspect: (environment: W) => Effect.Effect<Outcome, EvaluationError>
}

export const evaluationEnvironmentPort = <I, W>(id: string) =>
  Context.Service<EvaluationEnvironment<I, W>>(`efferent/evals/${id}/EvaluationEnvironment`)
