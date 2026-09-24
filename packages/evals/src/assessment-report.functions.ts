import { createHash } from "node:crypto"
import { Option } from "effect"
import type { EvaluationTrial } from "./assessment.entity.js"
import { summarizeAssessments } from "./assessment.entity.functions.js"

/** Stable across JSONB/object key order; array order is semantically significant. */
export const evaluationFingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
)).digest("hex")

export interface ComparisonIdentity {
  readonly datasetHash: string
  readonly fixtureHash: string
  readonly evaluatorHash: string
  readonly policyVersion: string
  readonly evidenceVersion: string
}
export interface EvaluationReport {
  readonly identity: ComparisonIdentity
  readonly trials: ReadonlyArray<EvaluationTrial>
}
const caseKey = (trial: EvaluationTrial) => `${trial.target}/${trial.dataset}/${trial.datasetVersion}/${trial.caseId}/${trial.split}/${trial.sample}`

export const comparisonIssues = (baseline: EvaluationReport, candidate: EvaluationReport): ReadonlyArray<string> => {
  const left = baseline.trials.map(caseKey)
  const right = candidate.trials.map(caseKey)
  return [
    ...(evaluationFingerprint(baseline.identity) !== evaluationFingerprint(candidate.identity) ? ["Dataset, fixture, evaluator, policy or evidence fingerprint mismatch"] : []),
    ...(left.length === 0 || right.length === 0 || new Set(left).size !== left.length || new Set(right).size !== right.length || left.length !== right.length || left.some((key) => !right.includes(key)) ? ["Incomplete, duplicate or mismatched case sets"] : []),
    ...baseline.trials.flatMap((trial) => {
      const other = candidate.trials.find((entry) => caseKey(entry) === caseKey(trial))
      const signature = (entry: EvaluationTrial) => entry.evaluations.map((result) => `${result.evaluator}@${result.evaluatorVersion}:${result.metrics.map((metric) => `${metric.name}:${metric.kind}`).sort().join(",")}`).sort()
      return other && evaluationFingerprint(signature(trial)) !== evaluationFingerprint(signature(other)) ? [`${caseKey(trial)}: evaluator or metric coverage mismatch`] : []
    }),
    ...[...baseline.trials, ...candidate.trials].flatMap((trial) => trial.status !== "completed" || trial.evaluations.length === 0 || trial.evaluations.some((result) => result.status !== "scored") ? [`${caseKey(trial)}: incomplete execution or assessment`] : []),
  ]
}

export const evaluationMarkdown = (trials: ReadonlyArray<EvaluationTrial>) => {
  const summary = summarizeAssessments(trials.flatMap((trial) => trial.evaluations))
  return [
    "# Evaluation report", "",
    `Trials: ${trials.filter((trial) => trial.status === "completed").length}/${trials.length} completed. Assessments: ${summary.scored}/${summary.total} scored; ${summary.errors} errors; ${summary.unavailable} unavailable; ${summary.skipped} skipped.`, "",
    "| Evaluator / metric | Measured cases | Mean |", "|---|---:|---:|",
    ...Object.entries(summary.metrics).map(([key, metric]) => `| ${key} | ${metric.count} | ${Option.match(metric.mean, { onNone: () => "unavailable", onSome: (value) => value.toFixed(3) })} |`),
    "", "Coverage is reported before scores. Costs and usage remain attached to individual assessments; missing usage is unavailable.",
  ].join("\n")
}
