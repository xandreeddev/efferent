import type { AiError } from "effect/ai"
import { Effect, Match, Option, Schema } from "effect"
import { AssessmentError, Metric, type EvaluationResult } from "./assessment.entity.js"
import type { Dataset } from "./assessment.usecase.js"

/**
 * A failed model call as an assessment error: `unavailable` when the
 * provider may answer on a retry (a rate limit, a network or server
 * failure, output that did not parse), `provider` otherwise. The message
 * names the reason (`RateLimitError: …`); the `AiError` is the cause.
 *
 * @public
 */
export const assessmentOfAiError = (error: AiError.AiError): AssessmentError => new AssessmentError({
  code: error.isRetryable ? "unavailable" : "provider",
  message: `${error.reason._tag}: ${error.message}`,
  cause: error,
})

/** @public */
export const validateDataset = Effect.fnUntraced(function* <I, Ref>(dataset: Dataset<I, Ref>) {
  const ids = dataset.cases.map((item) => item.id)
  const invalid = !dataset.id.trim() || !dataset.version.trim() || ids.length === 0 || new Set(ids).size !== ids.length ||
    dataset.cases.some((item) => !item.id.trim() || !item.family.trim() || !item.provenance.trim() || dataset.cases.some((other) => other.family === item.family && other.split !== item.split)) ||
    !dataset.cases.some((item) => item.split === "calibration") || !dataset.cases.some((item) => item.split === "validation")
  if (invalid) return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Dataset needs unique cases, provenance and disjoint calibration/validation families" }))
  yield* Effect.forEach(dataset.cases, (item) => Effect.all([
    Schema.decodeEffect(Schema.toType(dataset.input))(item.input), Schema.decodeEffect(Schema.toType(dataset.reference))(item.reference),
  ], { concurrency: 1 }).pipe(Effect.mapError((error) => new AssessmentError({ code: "invalid", message: `Dataset case ${item.id} does not decode: ${error.message}`, cause: error }))), { concurrency: 1 })
  return dataset
})

/** @public */
export const validateMetrics = (metrics: ReadonlyArray<Metric>, expected: ReadonlyArray<string>) =>
  Schema.decodeEffect(Schema.toType(Schema.Array(Metric)))(metrics).pipe(
    Effect.mapError((error) => new AssessmentError({ code: "invalid", message: `Evaluator returned invalid metrics: ${error.message}`, cause: error })),
    Effect.flatMap((values) => {
      const names = values.map((metric) => metric.name)
      return new Set(names).size !== names.length || expected.some((name) => !names.includes(name)) || names.some((name) => !expected.includes(name)) ||
        values.some((metric) => metric.kind === "score" && (metric.min >= metric.max || metric.value < metric.min || metric.value > metric.max))
        ? Effect.fail(new AssessmentError({ code: "invalid", message: "Evaluator returned missing, duplicate, unexpected or out-of-range metrics" }))
        : Effect.succeed(values)
    }),
  )

/** @public */
export const numericMetric = (metric: Metric): Option.Option<number> => Match.value(metric).pipe(
  Match.when({ kind: "boolean" }, (value) => Option.some(value.value ? 1 : 0)),
  Match.when({ kind: "probability" }, (value) => Option.some(value.value)),
  Match.when({ kind: "score" }, (value) => Option.some((value.value - value.min) / (value.max - value.min))),
  Match.when({ kind: "preference" }, () => Option.none()),
  Match.exhaustive,
)

/** @deprecated Grade with the evaluator behind a grader (`graderFromEvaluator`) and read the run: its grades and `runGates`. */
export const summarizeAssessments = (results: ReadonlyArray<EvaluationResult>) => ({
  total: results.length,
  scored: results.filter((result) => result.status === "scored").length,
  errors: results.filter((result) => result.status === "error").length,
  unavailable: results.filter((result) => result.status === "unavailable").length,
  skipped: results.filter((result) => result.status === "skipped").length,
  metrics: Object.fromEntries([...new Set(results.flatMap((result) => result.metrics.map((metric) => `${result.evaluator}/${metric.name}`)))].map((key) => {
    const values = results.filter((result) => result.status === "scored").flatMap((result) => result.metrics.filter((metric) => `${result.evaluator}/${metric.name}` === key).flatMap((metric) => Option.toArray(numericMetric(metric))))
    return [key, { count: values.length, mean: values.length ? Option.some(values.reduce((a, b) => a + b, 0) / values.length) : Option.none<number>() }]
  })),
})
