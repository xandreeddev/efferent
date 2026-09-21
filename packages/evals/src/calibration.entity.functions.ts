import { scoreSelection } from "./journey.entity.functions.js"
import type { CalibrationCase, CalibrationPrediction, CalibrationResult } from "./calibration.entity.js"

/** Exact selection is the default blocking gate. F2 is diagnostic: recall
 * cannot hide an unauthorized capability or a precision regression. */
export const scoreCalibration = (input: CalibrationCase, prediction: CalibrationPrediction): CalibrationResult => {
  const predicted = Object.entries(prediction.probabilities).filter(([, value]) => value >= prediction.threshold).map(([key]) => key)
  const scores = scoreSelection(input.expected, predicted, input.forbidden)
  const labels = [...new Set([...Object.keys(prediction.probabilities), ...input.expected, ...input.forbidden])]
  const brier = labels.length === 0 ? 0 : labels.reduce((sum, label) => sum + ((prediction.probabilities[label] ?? 0) - (input.expected.includes(label) ? 1 : 0)) ** 2, 0) / labels.length
  return { caseId: input.id, predicted, precision: scores.precision, recall: scores.recall, f2: scores.f2, brier, forbidden: scores.forbidden, passed: scores.exact && scores.forbidden.length === 0 }
}

/** Keep failures in the denominator. Callers must supply every attempted
 * repetition, including infrastructure failures and partial journeys. */
export const aggregateTrials = (trials: ReadonlyArray<{ readonly passed: boolean; readonly costUsd: number; readonly latencyMs: number }>) => {
  const latencies = trials.map((trial) => trial.latencyMs).toSorted((a, b) => a - b)
  return {
    attempts: trials.length, passed: trials.filter((trial) => trial.passed).length,
    passRate: trials.length === 0 ? 0 : trials.filter((trial) => trial.passed).length / trials.length,
    totalCostUsd: trials.reduce((sum, trial) => sum + trial.costUsd, 0),
    p95LatencyMs: latencies.length === 0 ? 0 : latencies[Math.ceil(latencies.length * 0.95) - 1]!,
    passedAll: trials.length > 0 && trials.every((trial) => trial.passed),
  }
}
