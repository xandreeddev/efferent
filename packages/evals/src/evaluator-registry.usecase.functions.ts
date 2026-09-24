import { Effect, Option } from "effect"
import { AssessmentError } from "./assessment.entity.js"
import type { Benchmark, Evaluator } from "./assessment.usecase.js"
import type { EvaluatorRegistration, PromptFamily } from "./evaluator-registry.usecase.js"

/** Adapts a narrow evaluator without exposing the parent evidence bundle to it. */
export const projectEvaluatorInput = <Whole, Input, R, P = never>(evaluator: Evaluator<Input, R>, project: (whole: Whole) => Effect.Effect<Input, AssessmentError, P>): Evaluator<Whole, R | P> => ({
  ...evaluator, run: (whole) => project(whole).pipe(Effect.flatMap(evaluator.run)),
})

export const evaluatorRegistry = <I, R>(entries: ReadonlyArray<EvaluatorRegistration<I, R>>) => Effect.gen(function* () {
  const keys = entries.map((entry) => `${entry.id}@${entry.version}`)
  if (new Set(keys).size !== keys.length || entries.some((entry) => !entry.id.trim() || !entry.version.trim() || !entry.projectionVersion.trim() || !entry.promptHash.trim() || entry.id !== entry.evaluator.id || entry.version !== entry.evaluator.version))
    return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Registry needs unique versioned entries and matching evaluator identities" }))
  return {
    entries,
    resolve: (id: string, version: string) => Option.fromNullable(entries.find((entry) => entry.id === id && entry.version === version)).pipe(
      Option.match({ onNone: () => Effect.fail(new AssessmentError({ code: "invalid", message: `Unknown evaluator ${id}@${version}` })), onSome: Effect.succeed }),
    ),
  }
})

export const promptFamilyBenchmark = <I, O, Ref, R>(family: PromptFamily<I, O, Ref, R>): Benchmark<I, O, O, Ref, R> => ({
  id: family.id, kind: "benchmark", dataset: family.dataset, output: family.output, evidence: family.output,
  task: (input) => family.evaluate(input).pipe(Effect.map((output) => ({ output, evidence: output }))),
  evaluators: family.comparator,
})
