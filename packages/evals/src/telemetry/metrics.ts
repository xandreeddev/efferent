import { Effect, Metric, MetricBoundaries } from "effect"

/**
 * Eval-only metrics — recorded by `runEval`, exported to Grafana via the same
 * collector when an OTLP endpoint is set. (The in-memory report reads scores
 * off the spans; these power the cross-run "Eval Results" dashboard.)
 */

const score = Metric.histogram(
  "eval_score",
  MetricBoundaries.linear({ start: 0, width: 0.1, count: 11 }),
  "Per-scorer score 0..1 (tags: suite, scorer).",
)

const cases = Metric.counter("eval_cases_total", {
  description: "Eval cases run (tags: suite, passed).",
  incremental: true,
})

export const recordEvalScore = (
  suite: string,
  scorer: string,
  value: number,
): Effect.Effect<void> =>
  Metric.update(score.pipe(Metric.tagged("suite", suite), Metric.tagged("scorer", scorer)), value)

export const recordEvalCase = (suite: string, passed: boolean): Effect.Effect<void> =>
  Metric.update(
    cases.pipe(Metric.tagged("suite", suite), Metric.tagged("passed", passed ? "true" : "false")),
    1,
  )
