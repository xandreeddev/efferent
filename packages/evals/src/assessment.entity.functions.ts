import { Effect, Match, Option, Schema } from "effect"
import { AssessmentError, Metric, type EvaluationResult, type EvaluationTrial } from "./assessment.entity.js"
import type { Dataset, Gate, GateResult } from "./assessment.usecase.js"

export const validateDataset = <I, Ref>(dataset: Dataset<I, Ref>) => Effect.gen(function* () {
  const ids = dataset.cases.map((item) => item.id)
  const invalid = !dataset.id.trim() || !dataset.version.trim() || ids.length === 0 || new Set(ids).size !== ids.length ||
    dataset.cases.some((item) => !item.id.trim() || !item.family.trim() || !item.provenance.trim() || dataset.cases.some((other) => other.family === item.family && other.split !== item.split)) ||
    !dataset.cases.some((item) => item.split === "calibration") || !dataset.cases.some((item) => item.split === "validation")
  if (invalid) return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Dataset needs unique cases, provenance and disjoint calibration/validation families" }))
  yield* Effect.forEach(dataset.cases, (item) => Effect.all([
    Schema.validate(dataset.input)(item.input), Schema.validate(dataset.reference)(item.reference),
  ]).pipe(Effect.mapError((error) => new AssessmentError({ code: "invalid", message: String(error) }))))
  return dataset
})

export const validateMetrics = (metrics: ReadonlyArray<Metric>, expected: ReadonlyArray<string>) =>
  Schema.validate(Schema.Array(Metric))(metrics).pipe(
    Effect.mapError((error) => new AssessmentError({ code: "invalid", message: String(error) })),
    Effect.flatMap((values) => {
      const names = values.map((metric) => metric.name)
      return new Set(names).size !== names.length || expected.some((name) => !names.includes(name)) || names.some((name) => !expected.includes(name)) ||
        values.some((metric) => metric.kind === "score" && (metric.min >= metric.max || metric.value < metric.min || metric.value > metric.max))
        ? Effect.fail(new AssessmentError({ code: "invalid", message: "Evaluator returned missing, duplicate, unexpected or out-of-range metrics" }))
        : Effect.succeed(values)
    }),
  )

export const numericMetric = (metric: Metric): Option.Option<number> => Match.value(metric).pipe(
  Match.when({ kind: "boolean" }, (value) => Option.some(value.value ? 1 : 0)),
  Match.when({ kind: "probability" }, (value) => Option.some(value.value)),
  Match.when({ kind: "score" }, (value) => Option.some((value.value - value.min) / (value.max - value.min))),
  Match.when({ kind: "preference" }, () => Option.none()),
  Match.exhaustive,
)

export const evaluateGates = (trial: EvaluationTrial, gates: ReadonlyArray<Gate>): GateResult => {
  const findings = gates.filter((gate) => gate.mode === "blocking").flatMap((gate) => {
    if (gate.requiresReviewedReference && trial.review === "provisional") return [`${gate.evaluator}/${gate.metric}: reference label needs review`]
    const result = trial.evaluations.find((value) => value.evaluator === gate.evaluator)
    const metric = result?.metrics.find((value) => value.name === gate.metric)
    const score = result?.status === "scored" && metric ? numericMetric(metric) : Option.none()
    return Option.isSome(score) && score.value >= gate.minimum ? [] : [`${gate.evaluator}/${gate.metric}: missing assessment or below ${gate.minimum}`]
  })
  return { passed: trial.status === "completed" && findings.length === 0, findings }
}

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
