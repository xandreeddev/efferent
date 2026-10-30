import { Array as Arr, Match, Option } from "effect"
import type { Metric } from "../assessment.entity.js"
import type { CalibrationObservation, CalibrationReference } from "./grader-calibration.entity.js"

/**
 * How one metric compares with the value expected of it.
 *
 * @public
 */
export interface MetricComparison {
  readonly agreement: boolean
  /** A pass (true, or a probability of at least 0.5) against a failing boolean label. */
  readonly falsePass: boolean
  /** A fail (false, or a probability under 0.5) against a passing boolean label. */
  readonly falseFail: boolean
  /** A probability against a boolean label: its squared error. */
  readonly brier: Option.Option<number>
  /** A score against a score on the same scale: the distance between them. */
  readonly absoluteError: Option.Option<number>
}

/** A pass/fail prediction against a boolean label. */
const verdict = (predicted: boolean, label: boolean, brier: Option.Option<number>): MetricComparison => ({
  agreement: predicted === label, falsePass: predicted && !label, falseFail: !predicted && label, brier, absoluteError: Option.none(),
})
const plain = (agreement: boolean, absoluteError: Option.Option<number>): MetricComparison => ({
  agreement, falsePass: false, falseFail: false, brier: Option.none(), absoluteError,
})

/**
 * `actual` against `expected` of the same name: booleans and preferences
 * agree when equal, two probabilities within `tolerance`, a probability
 * against a boolean label when `p >= 0.5` equals the label (with its Brier
 * score), two scores on the same scale within `tolerance` (with their
 * absolute error). None when they cannot be compared: another name, kind or
 * scale.
 *
 * @public
 */
export const compareMetric = (actual: Metric, expected: Metric, tolerance: number): Option.Option<MetricComparison> =>
  actual.name !== expected.name ? Option.none() : Match.value({ actual, expected }).pipe(
    Match.when({ actual: { kind: "boolean" }, expected: { kind: "boolean" } }, ({ actual, expected }) =>
      Option.some(verdict(actual.value, expected.value, Option.none()))),
    Match.when({ actual: { kind: "preference" }, expected: { kind: "preference" } }, ({ actual, expected }) =>
      Option.some(plain(actual.value === expected.value, Option.none()))),
    Match.when({ actual: { kind: "probability" }, expected: { kind: "probability" } }, ({ actual, expected }) =>
      Option.some(plain(Math.abs(actual.value - expected.value) <= tolerance, Option.none()))),
    Match.when({ actual: { kind: "probability" }, expected: { kind: "boolean" } }, ({ actual, expected }) =>
      Option.some(verdict(actual.value >= 0.5, expected.value, Option.some((actual.value - Number(expected.value)) ** 2)))),
    Match.when({ actual: { kind: "score" }, expected: { kind: "score" } }, ({ actual, expected }) =>
      actual.min === expected.min && actual.max === expected.max
        ? Option.some(plain(Math.abs(actual.value - expected.value) <= tolerance, Option.some(Math.abs(actual.value - expected.value))))
        : Option.none()),
    Match.orElse(() => Option.none()),
  )

/**
 * The agreement grade of a calibration: each labelled metric is compared
 * (`compareMetric`, with its tolerance) with the observed metric of its name,
 * and one that cannot be compared disagrees. Any observed metric of that name
 * that passes a failing label is a false pass, and one that fails a passing
 * label a false fail.
 *
 * @public
 */
export const calibrationAgreement = (
  actual: CalibrationObservation,
  reference: CalibrationReference,
  declaredMetrics: ReadonlyArray<string>,
): ReadonlyArray<Metric> => {
  const valid = new Set(actual.metrics.map((metric) => metric.name)).size === actual.metrics.length &&
    actual.metrics.every((metric) => declaredMetrics.includes(metric.name) &&
      (metric.kind !== "score" || metric.min < metric.max && metric.value >= metric.min && metric.value <= metric.max))
  const status = actual.status === reference.status
  const compared = reference.metrics.map(({ metric, tolerance }) => actual.metrics
    .filter((entry) => entry.name === metric.name)
    .map((entry) => compareMetric(entry, metric, tolerance)))
  const metrics = valid && (reference.status !== "scored" || reference.metrics.length > 0) &&
    compared.every((comparisons) => Arr.head(comparisons).pipe(Option.flatten, Option.exists((comparison) => comparison.agreement))) &&
    (actual.status === "scored" || actual.metrics.length === 0)
  const anyOf = (found: (comparison: MetricComparison) => boolean) =>
    compared.some((comparisons) => comparisons.some(Option.exists(found)))
  return [
    { kind: "boolean", name: "agreement", value: status && metrics },
    { kind: "boolean", name: "status-agreement", value: status },
    { kind: "boolean", name: "metric-agreement", value: metrics },
    { kind: "boolean", name: "false-pass", value: anyOf((comparison) => comparison.falsePass) },
    { kind: "boolean", name: "false-fail", value: anyOf((comparison) => comparison.falseFail) },
  ]
}

/**
 * `actual` against `reference` with no tolerance (`compareMetric`), as measured or unavailable with the reason.
 *
 * @public
 */
export const compareCalibrationMetric = (actual: Metric, reference: Metric) =>
  actual.name !== reference.name
    ? { status: "unavailable" as const, reason: "Metric IDs differ" }
    : Option.match(compareMetric(actual, reference, 0), {
      onNone: () => ({ status: "unavailable" as const, reason: "Incompatible metric kinds or scales" }),
      onSome: ({ agreement, brier, absoluteError, falsePass, falseFail }) =>
        ({ status: "measured" as const, agreement, brier, absoluteError, falsePass, falseFail }),
    })

/**
 * Aggregate only the pairs `compareMetric` measures (with no tolerance); missing predictions remain coverage gaps.
 *
 * @public
 */
export const summarizeCalibration = (pairs: ReadonlyArray<{ readonly actual: Option.Option<Metric>; readonly reference: Metric }>) => {
  const measured = pairs.flatMap(({ actual, reference }) => Option.toArray(actual).flatMap((metric) =>
    Option.toArray(compareMetric(metric, reference, 0)).map((result) => ({ metric, reference, result }))))
  // Only a boolean or a probability compares with a boolean label, so these are the pass/fail predictions.
  const binary = measured.filter(({ reference }) => reference.kind === "boolean")
  const tp = binary.filter(({ reference, result }) => result.agreement && reference.value === true).length
  const tn = binary.filter(({ reference, result }) => result.agreement && reference.value === false).length
  const fp = binary.filter(({ result }) => result.falsePass).length
  const fn = binary.filter(({ result }) => result.falseFail).length
  const ratio = (numerator: number, denominator: number) => denominator > 0 ? Option.some(numerator / denominator) : Option.none<number>()
  const mean = (values: ReadonlyArray<number>) => ratio(values.reduce((sum, value) => sum + value, 0), values.length)
  const probabilities = measured.flatMap(({ metric, reference }) =>
    metric.kind === "probability" && reference.kind === "boolean" ? [{ confidence: metric.value, outcome: Number(reference.value) }] : [])
  return {
    total: pairs.length, measured: measured.length, unavailable: pairs.length - measured.length,
    agreement: ratio(measured.filter(({ result }) => result.agreement).length, measured.length),
    brier: mean(measured.flatMap(({ result }) => Option.toArray(result.brier))),
    absoluteError: mean(measured.flatMap(({ result }) => Option.toArray(result.absoluteError))),
    confusion: { truePositive: tp, trueNegative: tn, falsePositive: fp, falseNegative: fn },
    precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    falsePassRate: ratio(fp, fp + tn), falseFailRate: ratio(fn, fn + tp),
    reliability: Array.from({ length: 10 }, (_, index) => {
      const values = probabilities.filter(({ confidence }) => Math.min(9, Math.floor(confidence * 10)) === index)
      return { lower: index / 10, upper: (index + 1) / 10, count: values.length,
        confidence: mean(values.map(({ confidence }) => confidence)),
        frequency: mean(values.map(({ outcome }) => outcome)),
      }
    }),
  }
}
