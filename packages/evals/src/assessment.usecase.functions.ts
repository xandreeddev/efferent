import { Cause, Clock, Effect, Exit, Option } from "effect"
import { AssessmentError, type EvaluationResult } from "./assessment.entity.js"
import { validateMetrics } from "./assessment.entity.functions.js"
import type { EvaluatorBinding } from "./assessment.usecase.js"

export const unknownEvaluationUsage = { inputTokens: Option.none<number>(), outputTokens: Option.none<number>(), costUsd: Option.none<number>() }

export const assess = <I, R>(binding: EvaluatorBinding<I, R>, input: I): Effect.Effect<EvaluationResult, never, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const evaluator = binding.evaluator
    const result = yield* evaluator.run(input).pipe(
      Effect.tap((value) => validateMetrics(value.metrics, evaluator.metrics)),
      Effect.timeoutOrElse({ duration: binding.timeoutMs ?? 90_000, orElse: () => Effect.fail((() => new AssessmentError({ code: "timeout", message: "Evaluator exceeded its deadline" }))()) }),
      Effect.exit,
    )
    const common = { version: 2 as const, evaluator: evaluator.id, evaluatorVersion: evaluator.version, startedAt, endedAt: yield* Clock.currentTimeMillis }
    if (Exit.isFailure(result)) {
      const error = Cause.findErrorOption(result.cause)
      return { ...common, status: Option.isSome(error) && error.value.code === "unavailable" ? "unavailable" as const : "error" as const, metrics: [], references: [], reason: Option.some(Cause.pretty(result.cause)), usage: unknownEvaluationUsage, metadata: {} }
    }
    return { ...common, status: "scored" as const, metrics: result.value.metrics.filter((metric) => binding.select.includes(metric.name)), reason: Option.some(result.value.reason), references: result.value.references ?? [], usage: result.value.usage ?? unknownEvaluationUsage, metadata: result.value.metadata ?? {} }
  }).pipe(Effect.withSpan("eval.evaluator", { attributes: { "eval.evaluator.id": binding.evaluator.id, "eval.evaluator.version": binding.evaluator.version } }))

export const validateBindings = <I, R>(bindings: ReadonlyArray<EvaluatorBinding<I, R>>) => {
  const ids = bindings.map((binding) => binding.evaluator.id)
  return new Set(ids).size !== ids.length || bindings.some(({ evaluator, select, timeoutMs }) => (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) || !evaluator.id.trim() || !evaluator.version.trim() || select.length === 0 || new Set(select).size !== select.length || new Set(evaluator.metrics).size !== evaluator.metrics.length || select.some((name) => !evaluator.metrics.includes(name)))
    ? Effect.fail(new AssessmentError({ code: "invalid", message: "Evaluator bindings require unique IDs and valid metric selections" }))
    : Effect.void
}

/** Also used to rescore saved evidence; no task execution or export is involved. */
export const assessAll = <I, R>(bindings: ReadonlyArray<EvaluatorBinding<I, R>>, input: I) =>
  validateBindings(bindings).pipe(Effect.andThen(Effect.forEach(bindings, (binding) => assess(binding, input))))
