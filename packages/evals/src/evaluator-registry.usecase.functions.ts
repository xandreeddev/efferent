import { Effect, Option } from "effect"
import { AssessmentError } from "./assessment.entity.js"
import type { Evaluator } from "./assessment.usecase.js"
import type { EvaluatorRegistration } from "./evaluator-registry.usecase.js"

/** Adapts a narrow evaluator without exposing the parent evidence bundle to it. */
export const projectEvaluatorInput = <Whole, Input, R, P = never>(evaluator: Evaluator<Input, R>, project: (whole: Whole) => Effect.Effect<Input, AssessmentError, P>): Evaluator<Whole, R | P> => ({
  ...evaluator, run: (whole) => project(whole).pipe(Effect.flatMap(evaluator.run)),
})

/** An application's registry value: unique `id@version` entries resolved by calibrations and journeys. */
export const evaluatorRegistry = <I, R>(entries: ReadonlyArray<EvaluatorRegistration<I, R>>) => Effect.gen(function* () {
  const keys = entries.map((entry) => `${entry.id}@${entry.version}`)
  if (new Set(keys).size !== keys.length || entries.some((entry) => !entry.id.trim() || !entry.version.trim() || !entry.projectionVersion.trim() || !entry.promptHash.trim() || entry.id !== entry.evaluator.id || entry.version !== entry.evaluator.version))
    return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Registry needs unique versioned entries and matching evaluator identities" }))
  return {
    entries,
    resolve: (id: string, version: string) => Option.fromNullishOr(entries.find((entry) => entry.id === id && entry.version === version)).pipe(
      Option.match({ onNone: () => Effect.fail(new AssessmentError({ code: "invalid", message: `Unknown evaluator ${id}@${version}` })), onSome: Effect.succeed }),
    ),
  }
})
