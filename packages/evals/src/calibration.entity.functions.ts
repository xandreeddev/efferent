import { Option, Schema } from "effect"
import type { EvaluationTrial, Metric } from "./assessment.entity.js"
import { numericMetric, summarizeAssessments } from "./assessment.entity.functions.js"
import type { Dataset } from "./assessment.usecase.js"
import { evaluationFingerprint } from "./assessment-report.functions.js"
import type { CalibrationIdentity, CalibrationReport, CandidatePerformance, CandidateReport, GateReport } from "./calibration.entity.js"
import type { AggregateGate, Calibration, JudgeCalibration } from "./calibration.usecase.js"
import { summarizeCalibration } from "./evaluator-calibration.entity.functions.js"
import { percentile } from "./stats.js"

/** Everything that must be equal before two reports of a calibration are compared. */
export const calibrationIdentity = <I, O, E, Ref, C extends { readonly id: string }, R, Shared>(definition: Calibration<I, O, E, Ref, C, R, Shared>): CalibrationIdentity => ({
  calibration: `${definition.id}@${definition.version}`,
  datasetHash: evaluationFingerprint({ id: definition.dataset.id, version: definition.dataset.version, cases: definition.dataset.cases }),
  evaluatorHash: evaluationFingerprint(definition.evaluators.map((binding) => ({ id: binding.evaluator.id, version: binding.evaluator.version, select: binding.select }))),
  subjectHash: evaluationFingerprint(definition.subject.fingerprints),
  candidatesHash: evaluationFingerprint(definition.candidates),
})

/** One numeric value per trial: the named metric of the gate's evaluator, when scored. */
const gateValues = (trials: ReadonlyArray<EvaluationTrial>, gate: AggregateGate): ReadonlyArray<number> =>
  trials.flatMap((trial) => trial.evaluations
    .filter((result) => result.status === "scored" && result.evaluator === gate.evaluator)
    .flatMap((result) => result.metrics.filter((metric) => metric.name === gate.metric).flatMap((metric) => Option.toArray(numericMetric(metric)))))

/** `mean` averages scored values; `passRate` counts trials at exactly 1 over every attempt. */
export const evaluateAggregateGate = (trials: ReadonlyArray<EvaluationTrial>, gate: AggregateGate, reviewed: boolean): GateReport => {
  const values = gateValues(trials, gate)
  const value = gate.aggregate === "mean"
    ? (values.length === 0 ? Option.none<number>() : Option.some(values.reduce((sum, item) => sum + item, 0) / values.length))
    : (trials.length === 0 ? Option.none<number>() : Option.some(values.filter((item) => item >= 1).length / trials.length))
  const findings = [
    ...(gate.requiresReviewedReference === true && !reviewed ? ["reference labels need review"] : []),
    ...(Option.isNone(value) ? ["no measured value"] : []),
    ...(gate.minimum !== undefined && Option.isSome(value) && value.value < gate.minimum ? [`${value.value.toFixed(3)} is below ${gate.minimum}`] : []),
    ...(gate.maximum !== undefined && Option.isSome(value) && value.value > gate.maximum ? [`${value.value.toFixed(3)} is above ${gate.maximum}`] : []),
  ].map((finding) => `${gate.evaluator}/${gate.metric} (${gate.aggregate}): ${finding}`)
  return { evaluator: gate.evaluator, metric: gate.metric, aggregate: gate.aggregate, mode: gate.mode, value, passed: findings.length === 0, findings }
}

const sumKnown = (values: ReadonlyArray<Option.Option<number>>): Option.Option<number> =>
  values.length > 0 && values.every(Option.isSome) ? Option.some(values.flatMap(Option.toArray).reduce((sum, item) => sum + item, 0)) : Option.none()

/** Latency over every attempt, failures included; judge usage only when every scored assessment reported it. */
export const candidatePerformance = (trials: ReadonlyArray<EvaluationTrial>): CandidatePerformance => {
  const latencies = trials.map((trial) => trial.endedAt - trial.startedAt)
  const scored = trials.flatMap((trial) => trial.evaluations.filter((result) => result.status === "scored"))
  return {
    attempts: trials.length,
    completed: trials.filter((trial) => trial.status === "completed").length,
    failed: trials.filter((trial) => trial.status === "error" || trial.status === "skipped").length,
    cancelled: trials.filter((trial) => trial.status === "cancelled").length,
    p50LatencyMs: latencies.length === 0 ? Option.none() : Option.some(percentile(latencies, 0.5)),
    p95LatencyMs: latencies.length === 0 ? Option.none() : Option.some(percentile(latencies, 0.95)),
    judgeInputTokens: sumKnown(scored.map((result) => result.usage.inputTokens)),
    judgeOutputTokens: sumKnown(scored.map((result) => result.usage.outputTokens)),
    judgeCostUsd: sumKnown(scored.map((result) => result.usage.costUsd)),
  }
}

/** Reference labels paired with the subject's metrics; a trial without output leaves coverage gaps. */
export const judgeCalibrationSummary = <I, O, Ref>(trials: ReadonlyArray<EvaluationTrial>, dataset: Dataset<I, Ref>, output: Schema.Codec<O>, calibration: JudgeCalibration<Ref, O>) => {
  const decode = Schema.decodeUnknownOption(Schema.toType(output))
  const pairs = trials.flatMap((trial) => Option.fromNullishOr(dataset.cases.find((entry) => entry.id === trial.caseId)).pipe(
    Option.match({
      onNone: () => [],
      onSome: (entry) => {
        const actual = Option.flatMap(trial.output, decode).pipe(Option.map(calibration.actual))
        return calibration.reference(entry.reference).map((reference) => ({
          reference,
          actual: Option.flatMap(actual, (metrics) => Option.fromNullishOr(metrics.find((metric: Metric) => metric.name === reference.name))),
        }))
      },
    }),
  ))
  return summarizeCalibration(pairs)
}

export const candidateReport = <I, O, E, Ref, C extends { readonly id: string }, R, Shared>(
  definition: Calibration<I, O, E, Ref, C, R, Shared>,
  candidate: C,
  encoded: Readonly<Record<string, unknown>>,
  trials: ReadonlyArray<EvaluationTrial>,
  reviewed: boolean,
): CandidateReport => {
  const gates = definition.gates.map((gate) => evaluateAggregateGate(trials, gate, reviewed))
  return {
    id: candidate.id,
    candidate: encoded,
    trials: trials.map((trial) => trial.id),
    metrics: summarizeAssessments(trials.flatMap((trial) => trial.evaluations)).metrics,
    gates,
    passed: trials.length > 0 && trials.every((trial) => trial.status === "completed") && gates.every((gate) => gate.mode === "diagnostic" || gate.passed),
    calibration: Option.fromNullishOr(definition.judgeCalibration).pipe(Option.map((calibration) => judgeCalibrationSummary(trials, definition.dataset, definition.output, calibration))),
    performance: candidatePerformance(trials),
  }
}

const cell = (value: Option.Option<number>): string => Option.match(value, { onNone: () => "n/a", onSome: (item) => item.toFixed(3) })

export const calibrationMarkdown = (report: CalibrationReport): string => {
  const metrics = [...new Set(report.candidates.flatMap((candidate) => Object.keys(candidate.metrics)))].toSorted()
  const header = ["Candidate", "Passed", "Completed", ...metrics, "p95 ms", "Gate findings"]
  const rows = report.candidates.map((candidate) => [
    candidate.id,
    candidate.passed ? "yes" : "no",
    `${candidate.performance.completed}/${candidate.performance.attempts}`,
    ...metrics.map((key) => cell(Option.fromNullishOr(candidate.metrics[key]).pipe(Option.flatMap((summary) => summary.mean)))),
    cell(candidate.performance.p95LatencyMs),
    candidate.gates.filter((gate) => gate.mode === "blocking" && !gate.passed).flatMap((gate) => gate.findings).join("; ") || "none",
  ])
  return [
    `# Calibration ${report.identity.calibration}`,
    "",
    `Run ${report.run.runId} on the ${report.run.split} split: ${report.trials.filter((trial) => trial.status === "completed").length}/${report.trials.length} trials completed, ${report.failures.length} candidate failures, labels ${report.reviewed ? "reviewed" : "provisional"}.`,
    "",
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
    "",
    Option.match(report.recommendation, {
      onNone: () => "No selection policy declared; no recommendation.",
      onSome: (id) => `Recommendation: ${id} (promotion ${report.promotionEligible ? "eligible" : "not eligible"}).`,
    }),
    "",
  ].join("\n")
}
