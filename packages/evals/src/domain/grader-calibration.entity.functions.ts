import type { Metric } from "../assessment.entity.js"
import type { CalibrationObservation, CalibrationReference } from "./grader-calibration.entity.js"

const agrees = (actual: Metric, expected: Metric, tolerance: number): boolean =>
  actual.kind === "score" && expected.kind === "score"
    ? actual.min === expected.min && actual.max === expected.max && Math.abs(actual.value - expected.value) <= tolerance
    : actual.kind === "probability" && expected.kind === "probability"
      ? Math.abs(actual.value - expected.value) <= tolerance
      : actual.kind === expected.kind && actual.value === expected.value

export const calibrationAgreement = (
  actual: CalibrationObservation,
  reference: CalibrationReference,
  declaredMetrics: ReadonlyArray<string>,
): ReadonlyArray<Metric> => {
  const valid = new Set(actual.metrics.map((metric) => metric.name)).size === actual.metrics.length &&
    actual.metrics.every((metric) => declaredMetrics.includes(metric.name) &&
      (metric.kind !== "score" || metric.min < metric.max && metric.value >= metric.min && metric.value <= metric.max))
  const status = actual.status === reference.status
  const metrics = valid && (reference.status !== "scored" || reference.metrics.length > 0) && reference.metrics.every(({ metric, tolerance }) => {
    const observed = actual.metrics.find((entry) => entry.name === metric.name)
    return observed !== undefined && agrees(observed, metric, tolerance)
  }) && (actual.status === "scored" || actual.metrics.length === 0)
  const falsePass = reference.metrics.some(({ metric }) => metric.kind === "boolean" && !metric.value &&
    actual.metrics.some((entry) => entry.name === metric.name && entry.kind === "boolean" && entry.value))
  const falseFail = reference.metrics.some(({ metric }) => metric.kind === "boolean" && metric.value &&
    actual.metrics.some((entry) => entry.name === metric.name && entry.kind === "boolean" && !entry.value))
  return [
    { kind: "boolean", name: "agreement", value: status && metrics },
    { kind: "boolean", name: "status-agreement", value: status },
    { kind: "boolean", name: "metric-agreement", value: metrics },
    { kind: "boolean", name: "false-pass", value: falsePass },
    { kind: "boolean", name: "false-fail", value: falseFail },
  ]
}
