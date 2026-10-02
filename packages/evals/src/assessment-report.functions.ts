import { createHash } from "node:crypto"
import type { EvaluationTrial } from "./assessment.entity.js"
import type { CalibrationReport } from "./calibration.entity.js"

/** Stable across JSONB/object key order; array order is semantically significant. */
export const evaluationFingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
  item !== null && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item,
)).digest("hex")

const caseKey = (trial: EvaluationTrial) => `${String(trial.candidate.id)}/${trial.target}/${trial.dataset}/${trial.datasetVersion}/${trial.caseId}/${trial.split}/${trial.sample}`

/** Two reports of one calibration compare only with equal identity, case sets and metric coverage, all complete. */
export const comparisonIssues = (baseline: CalibrationReport, candidate: CalibrationReport): ReadonlyArray<string> => {
  const left = baseline.trials.map(caseKey)
  const right = candidate.trials.map(caseKey)
  return [
    ...(evaluationFingerprint(baseline.identity) !== evaluationFingerprint(candidate.identity) ? ["Calibration, dataset, evaluator, subject or candidate fingerprint mismatch"] : []),
    ...(left.length === 0 || right.length === 0 || new Set(left).size !== left.length || new Set(right).size !== right.length || left.length !== right.length || left.some((key) => !right.includes(key)) ? ["Incomplete, duplicate or mismatched case sets"] : []),
    ...baseline.trials.flatMap((trial) => {
      const other = candidate.trials.find((entry) => caseKey(entry) === caseKey(trial))
      const signature = (entry: EvaluationTrial) => entry.evaluations.map((result) => `${result.evaluator}@${result.evaluatorVersion}:${result.metrics.map((metric) => `${metric.name}:${metric.kind}`).sort().join(",")}`).sort()
      return other && evaluationFingerprint(signature(trial)) !== evaluationFingerprint(signature(other)) ? [`${caseKey(trial)}: evaluator or metric coverage mismatch`] : []
    }),
    ...[...baseline.trials, ...candidate.trials].flatMap((trial) => trial.status !== "completed" || trial.evaluations.length === 0 || trial.evaluations.some((result) => result.status !== "scored") ? [`${caseKey(trial)}: incomplete execution or assessment`] : []),
  ]
}
