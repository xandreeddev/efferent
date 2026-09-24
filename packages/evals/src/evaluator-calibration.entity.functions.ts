import { Option } from "effect"
import type { Metric } from "./assessment.entity.js"

/** Reference labels remain outside the evaluator's prompt. Only matching kinds compare. */
export const compareCalibrationMetric = (actual: Metric, reference: Metric) => {
  if (actual.name !== reference.name) return { status: "unavailable" as const, reason: "Metric IDs differ" }
  if (actual.kind === "probability" && reference.kind === "boolean") {
    const predicted = actual.value >= 0.5
    return { status: "measured" as const, agreement: predicted === reference.value, brier: Option.some((actual.value - Number(reference.value)) ** 2), absoluteError: Option.none<number>(), falsePass: predicted && !reference.value, falseFail: !predicted && reference.value }
  }
  if (actual.kind === "score" && reference.kind === "score" && actual.min === reference.min && actual.max === reference.max)
    return { status: "measured" as const, agreement: actual.value === reference.value, brier: Option.none<number>(), absoluteError: Option.some(Math.abs(actual.value - reference.value)), falsePass: false, falseFail: false }
  if ((actual.kind === "boolean" && reference.kind === "boolean") || (actual.kind === "preference" && reference.kind === "preference"))
    return { status: "measured" as const, agreement: actual.value === reference.value, brier: Option.none<number>(), absoluteError: Option.none<number>(), falsePass: actual.kind === "boolean" && actual.value && !reference.value, falseFail: actual.kind === "boolean" && !actual.value && Boolean(reference.value) }
  return { status: "unavailable" as const, reason: "Incompatible metric kinds or scales" }
}

/** Aggregate only compatible measured pairs; missing predictions remain coverage gaps. */
export const summarizeCalibration = (pairs: ReadonlyArray<{ readonly actual: Option.Option<Metric>; readonly reference: Metric }>) => {
  const measured = pairs.flatMap(({ actual, reference }) => Option.toArray(actual).flatMap((metric) => {
    const result = compareCalibrationMetric(metric, reference)
    return result.status === "measured" ? [{ metric, reference, result }] : []
  }))
  const binary = measured.filter(({ metric, reference }) => (metric.kind === "boolean" || metric.kind === "probability") && reference.kind === "boolean")
  const predicted = (metric: Metric) => metric.kind === "boolean" ? metric.value : metric.kind === "probability" && metric.value >= 0.5
  const tp = binary.filter(({ metric, reference }) => predicted(metric) && reference.value === true).length
  const tn = binary.filter(({ metric, reference }) => !predicted(metric) && reference.value === false).length
  const fp = binary.filter(({ result }) => result.falsePass).length
  const fn = binary.filter(({ result }) => result.falseFail).length
  const ratio = (numerator: number, denominator: number) => denominator > 0 ? Option.some(numerator / denominator) : Option.none<number>()
  const mean = (values: ReadonlyArray<number>) => ratio(values.reduce((sum, value) => sum + value, 0), values.length)
  const probabilities = measured.filter(({ metric, reference }) => metric.kind === "probability" && reference.kind === "boolean")
  return {
    total: pairs.length, measured: measured.length, unavailable: pairs.length - measured.length,
    agreement: ratio(measured.filter(({ result }) => result.agreement).length, measured.length),
    brier: mean(measured.flatMap(({ result }) => Option.toArray(result.brier))),
    absoluteError: mean(measured.flatMap(({ result }) => Option.toArray(result.absoluteError))),
    confusion: { truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn },
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    falsePassRate: ratio(fp, fp + tn), falseFailRate: ratio(fn, fn + tp),
    reliability: Array.from({ length: 10 }, (_, index) => {
      const values = probabilities.filter(({ metric }) => metric.kind === "probability" && Math.min(9, Math.floor(metric.value * 10)) === index)
      return { lower: index / 10, upper: (index + 1) / 10, count: values.length,
        confidence: mean(values.flatMap(({ metric }) => metric.kind === "probability" ? [metric.value] : [])),
        frequency: mean(values.map(({ reference }) => Number(reference.value))),
      }
    }),
  }
}
