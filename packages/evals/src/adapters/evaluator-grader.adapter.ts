import { Effect, Layer, Schema } from "effect"
import { AssessmentError } from "../assessment.entity.js"
import { validateMetrics } from "../assessment.entity.functions.js"
import type { Evaluator } from "../assessment.usecase.js"
import { unknownEvaluationUsage } from "../assessment.usecase.functions.js"
import type { GraderRegistration } from "../contracts/evaluation-app.contract.js"
import type { Grader } from "../domain/grader.entity.js"
import { EvaluationError } from "../domain/identity.entity.js"
import { GraderAssessment } from "../ports/grader-assessment.port.js"

/** An evaluator's failure as a grade's: the same code, message and cause (every assessment code is an evaluation code). */
const evaluationErrorOf = (error: AssessmentError): EvaluationError =>
  new EvaluationError({ code: error.code, message: error.message, cause: error.cause })

/**
 * An evaluator behind a grader: the one way a judging primitive (a
 * `semanticEvaluator`, a host's `Evaluator` over a model) grades a trial.
 * The registration keeps `definition`; each grade decodes the grading
 * context's `input` with `input` (the codec the projection encoded it
 * with), runs the evaluator with `services` (what it requires, built in
 * the grade's scope) within `timeoutMs` (90 s), checks its metrics as
 * `assess` did, and keeps the grader's `metrics`. A non-empty `references`
 * list is the grade's `metadata.references`.
 *
 * The layer fails `invalid` when the evaluator does not declare every
 * metric of the grader, or the deadline is not a positive number. An input
 * that does not decode is `invalid`; an `AssessmentError` becomes the
 * `EvaluationError` of the same code, message and cause, so an `unavailable`
 * one stays a missing measurement.
 */
export const graderFromEvaluator = <I, R>(options: {
  readonly definition: Grader
  readonly input: Schema.Codec<I, unknown>
  readonly evaluator: Evaluator<I, R>
  readonly timeoutMs?: number
}, services: Layer.Layer<R, EvaluationError | AssessmentError>): GraderRegistration => {
  const { definition, evaluator } = options
  const key = `${definition.id}@${definition.version}`
  const timeoutMs = options.timeoutMs ?? 90_000
  const decode = Schema.decodeUnknownEffect(options.input)
  return {
    definition,
    layer: Layer.effect(GraderAssessment, Effect.gen(function* () {
      const undeclared = definition.metrics.filter((name) => !evaluator.metrics.includes(name))
      if (undeclared.length > 0)
        return yield* Effect.fail(new EvaluationError({ code: "invalid", message: `Grader ${key} measures ${undeclared.join(", ")}, which evaluator ${evaluator.id}@${evaluator.version} does not declare` }))
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        return yield* Effect.fail(new EvaluationError({ code: "invalid", message: `Grader ${key}: the evaluator's deadline must be a positive number of milliseconds` }))
      const context = yield* Layer.build(services).pipe(Effect.catchTag("AssessmentError", (error) => Effect.fail(evaluationErrorOf(error))))
      return GraderAssessment.of({
        assess: Effect.fn("eval.evaluator", { attributes: { "eval.evaluator.id": evaluator.id, "eval.evaluator.version": evaluator.version } })(function* (grading) {
          const input = yield* decode(grading.input).pipe(
            Effect.mapError((error) => new EvaluationError({ code: "invalid", message: `Grading context does not decode as grader ${key}'s input: ${error.message}`, cause: error })),
          )
          const assessment = yield* evaluator.run(input).pipe(
            Effect.tap((value) => validateMetrics(value.metrics, evaluator.metrics)),
            Effect.provide(context),
            Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new AssessmentError({ code: "timeout", message: "Evaluator exceeded its deadline" })) }),
            Effect.catchTag("AssessmentError", (error) => Effect.fail(evaluationErrorOf(error))),
          )
          const references = assessment.references ?? []
          const metadata = assessment.metadata ?? {}
          return {
            status: "scored" as const,
            metrics: assessment.metrics.filter((metric) => definition.metrics.includes(metric.name)),
            reason: assessment.reason,
            usage: assessment.usage ?? unknownEvaluationUsage,
            metadata: references.length === 0 ? metadata : { ...metadata, references },
          }
        }),
      })
    })),
  }
}
