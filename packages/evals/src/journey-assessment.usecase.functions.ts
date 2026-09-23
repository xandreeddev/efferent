import { Cause, Effect, Exit, Ref } from "effect"
import type { Scope } from "effect"
import type { AssessmentError } from "./assessment.entity.js"

/** Ordered actions share a scoped world. The driver owns durable observation
 * writes, so partially completed journeys survive interruption and failure. */
export const journeyTask = <I, W, O, E, R>(definition: {
  readonly boot: (input: I) => Effect.Effect<W, AssessmentError, R | Scope.Scope>
  readonly steps: (input: I) => ReadonlyArray<{ readonly id: string; readonly act: (world: W) => Effect.Effect<O, AssessmentError, R> }>
  readonly record: (step: string, observation: O) => Effect.Effect<void, AssessmentError, R>
  readonly evidence: (world: W, observations: ReadonlyArray<O>) => Effect.Effect<E, AssessmentError, R>
}) => (input: I) => Effect.gen(function* () {
  const world = yield* definition.boot(input)
  const observations = yield* Ref.make<ReadonlyArray<O>>([])
  const execution = yield* Effect.forEach(definition.steps(input), (step) => step.act(world).pipe(
    Effect.tap((value) => definition.record(step.id, value)),
    Effect.tap((value) => Ref.update(observations, (prior) => [...prior, value])),
  )).pipe(Effect.exit)
  const output = yield* Ref.get(observations)
  const evidence = yield* definition.evidence(world, output)
  return { output: { observations: output, completed: Exit.isSuccess(execution), errors: Exit.isFailure(execution) ? [Cause.pretty(execution.cause)] : [] }, evidence }
})
