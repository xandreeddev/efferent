import { Option } from "effect"
import type { Metric } from "../assessment.entity.js"
import type { Trial } from "./trial.entity.js"
import type { EvaluationRun } from "./evaluation-run.entity.js"
import type { ComparisonReport } from "./comparison-report.entity.js"
import type { ComparisonSpecification, ComparisonSide } from "./comparison-specification.entity.js"
import { fingerprint } from "./grading-context.entity.functions.js"
import { runGates } from "./evaluation-run.entity.functions.js"
import {
  comparisonFamily, comparisonSpecificationFingerprint, comparisonSpecificationIssues,
  comparisonTaskFingerprint, comparisonTaskKey, comparisonSubjectFingerprints,
} from "./comparison-specification.entity.functions.js"

const mean = (values: ReadonlyArray<number>): number => values.reduce((sum, value) => sum + value, 0) / values.length
const sampleIndex = (seed: number, draw: number, position: number, length: number): number => {
  const initial = (Math.imul(draw + 1, 0x9e3779b1) + Math.imul(position + 1, 0x85ebca6b) + Math.imul(seed, 0xc2b2ae35)) >>> 0
  const first = Math.imul(initial ^ (initial >>> 16), 0x7feb352d)
  const second = Math.imul(first ^ (first >>> 15), 0x846ca68b)
  return ((second ^ (second >>> 16)) >>> 0) % length
}
/** Paired resampling of independent family means; cases and repetitions are never resampled as independent. */
export const pairedFamilyInterval = (values: ReadonlyArray<number>, seed: number) => {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return Option.none<{ readonly estimate: number; readonly low: number; readonly high: number }>()
  if (values.every((value) => value === values[0])) return Option.none<{ readonly estimate: number; readonly low: number; readonly high: number }>()
  const draws = Array.from({ length: 10000 }, (_, draw) => mean(Array.from({ length: values.length }, (_, position) => values[sampleIndex(seed, draw, position, values.length)]!))).sort((a, b) => a - b)
  return draws[249] === draws[9749] ? Option.none() : Option.some({ estimate: mean(values), low: draws[249]!, high: draws[9749]! })
}
const trialKey = (trial: Trial): string => JSON.stringify([trial.suiteId, trial.task.id, trial.sample])
const metricSignature = (metric: Metric): string => fingerprint({ kind: metric.kind, ...(metric.kind === "score" ? { min: metric.min, max: metric.max } : {}) })
/** Practical margins use the metric's original units, never normalized gate scores. */
const primaryNumber = (metric: Metric): Option.Option<number> => metric.kind === "boolean"
  ? Option.some(Number(metric.value)) : metric.kind === "probability"
    ? Number.isFinite(metric.value) && metric.value >= 0 && metric.value <= 1 ? Option.some(metric.value) : Option.none()
    : metric.kind === "score" && Number.isFinite(metric.value) && Number.isFinite(metric.min) && Number.isFinite(metric.max) && metric.min < metric.max && metric.value >= metric.min && metric.value <= metric.max
      ? Option.some(metric.value) : Option.none()
const primaryMetrics = (trial: Trial, spec: ComparisonSpecification): ReadonlyArray<Metric> => trial.grades.filter((grade) =>
  `${grade.grader}@${grade.version}` === spec.primary.grader && grade.status === "scored",
).flatMap((grade) => grade.metrics.filter((metric) => metric.name === spec.primary.metric))
const primaryValue = (trial: Trial, spec: ComparisonSpecification): Option.Option<number> => {
  const bindings = trial.task.graders.filter((binding) => binding.grader === spec.primary.grader)
  const values = bindings.map((binding) => {
    const grades = trial.grades.filter((grade) => `${grade.grader}@${grade.version}` === binding.grader && grade.scope === binding.scope)
    const metrics = grades.flatMap((grade) => grade.status === "scored" ? grade.metrics.filter((metric) => metric.name === spec.primary.metric) : [])
    return grades.length === 1 && metrics.length === 1 ? primaryNumber(metrics[0]!) : Option.none<number>()
  })
  return trial.status === "completed" && values.length > 0 && values.every(Option.isSome)
    ? Option.some(mean(values.flatMap(Option.toArray))) : Option.none()
}
const requiredBinding = (trial: Trial, grader: string, spec: ComparisonSpecification): boolean => grader === spec.primary.grader || spec.gates.some((entry) => entry.suiteId === trial.suiteId && entry.gate.mode === "blocking" && entry.gate.grader === grader)
const completeGrades = (trial: Trial, spec: ComparisonSpecification): boolean => trial.status === "completed" &&
  trial.task.graders.filter((binding) => requiredBinding(trial, binding.grader, spec)).every((binding) => {
    const grades = trial.grades.filter((grade) => `${grade.grader}@${grade.version}` === binding.grader && grade.scope === binding.scope)
    return grades.length === 1 && grades[0]!.status === "scored"
  })
const runIssues = (run: EvaluationRun, spec: ComparisonSpecification, side: ComparisonSide): ReadonlyArray<string> => {
  const subject = spec[side]
  const expected = new Map(spec.tasks.map((task) => [comparisonTaskKey(task.suiteId, task.taskId), task.fingerprint]))
  return [
    ...(run.application !== spec.application ? [`${side}: application differs`] : []),
    ...(run.fingerprints.comparisonSpecification !== comparisonSpecificationFingerprint(spec) || run.fingerprints.comparisonSide !== side ? [`${side}: no matching prospective specification/side`] : []),
    ...(run.fingerprints.comparisonGrading !== spec.gradingConfiguration || (run.phase === "graded" && run.fingerprints.gradingConfiguration !== spec.gradingConfiguration) ? [`${side}: assessment configuration differs`] : []),
    ...(run.fingerprints.comparisonGates !== fingerprint(spec.gates.map(fingerprint).sort()) ? [`${side}: frozen gates differ`] : []),
    ...(run.fingerprints.comparisonExecution !== fingerprint(spec.execution.map(fingerprint).sort()) ? [`${side}: execution settings differ`] : []),
    ...(fingerprint(comparisonSubjectFingerprints(run.fingerprints)) !== fingerprint(subject.fingerprints) ? [`${side}: frozen subject fingerprints differ`] : []),
    ...(new Set(run.trials.map(trialKey)).size !== run.trials.length ? [`${side}: duplicate trial pair key`] : []),
    ...(run.trials.some((trial) => expected.get(comparisonTaskKey(trial.suiteId, trial.task.id)) !== comparisonTaskFingerprint(trial.task)) ? [`${side}: unexpected or changed task, reference, family or grader binding`] : []),
    ...(run.trials.some((trial) => trial.sample < 1 || trial.sample > spec.repetitions) ? [`${side}: unexpected repetition`] : []),
    ...(run.trials.some((trial) => fingerprint(trial.candidate) !== fingerprint(subject.candidate)) ? [`${side}: frozen candidate differs`] : []),
  ]
}
const candidateGates = (candidate: EvaluationRun, spec: ComparisonSpecification) => {
  const suites = [...new Set(spec.tasks.map((task) => task.suiteId))].map((id) => ({
    id, version: "comparison", purpose: "regression" as const, description: "Frozen comparison gates",
    tasks: candidate.trials.filter((trial) => trial.suiteId === id).map((trial) => trial.task).filter((task, index, tasks) => tasks.findIndex((entry) => entry.id === task.id) === index),
    candidates: [spec.candidate.candidate], gates: spec.gates.filter((entry) => entry.suiteId === id).map((entry) => entry.gate),
    repetitions: spec.repetitions, concurrency: 1, timeoutMs: 1,
  }))
  return runGates(suites, candidate.trials).filter((gate) => gate.mode === "blocking")
}

/** Reads only immutable reports. It never executes a subject, changes labels, or interprets a failure as zero. */
export const compareEvaluations = (baseline: EvaluationRun, candidate: EvaluationRun, spec: ComparisonSpecification): ComparisonReport => {
  const incompatible = [...comparisonSpecificationIssues(spec), ...runIssues(baseline, spec, "baseline"), ...runIssues(candidate, spec, "candidate")]
  const signatures = [...new Set([...baseline.trials, ...candidate.trials].flatMap((trial) => primaryMetrics(trial, spec).map(metricSignature)))]
  const incompatibilities = [...incompatible, ...(signatures.length > 1 ? ["Primary metric kinds or scales differ"] : [])]
  const expected = spec.tasks.flatMap((task) => Array.from({ length: spec.repetitions }, (_, index) => ({ ...task, sample: index + 1 })))
  const paired = expected.map((entry) => {
    const match = (trial: Trial) => trial.suiteId === entry.suiteId && trial.task.id === entry.taskId && trial.sample === entry.sample
    const left = Option.fromNullishOr(baseline.trials.find(match))
    const right = Option.fromNullishOr(candidate.trials.find(match))
    const value = Option.flatMap(left, (a) => Option.flatMap(right, (b) => Option.flatMap(primaryValue(a, spec), (av) => Option.map(primaryValue(b, spec), (bv) => (bv - av) * (spec.primary.direction === "higher" ? 1 : -1)))))
    return { entry, left, right, value }
  })
  const measured = paired.filter((pair) => Option.isSome(pair.value))
  const taskResults = spec.tasks.map((task) => {
    const pairs = paired.filter((pair) => pair.entry.suiteId === task.suiteId && pair.entry.taskId === task.taskId)
    const values = pairs.flatMap((pair) => Option.toArray(pair.value))
    const first = pairs.flatMap((pair) => Option.toArray(pair.left))[0]
    return { suiteId: task.suiteId, taskId: task.taskId, family: first ? comparisonFamily(first.task) : "", measuredPairs: values.length, improvement: values.length === spec.repetitions ? Option.some(mean(values)) : Option.none<number>() }
  })
  const tasks = taskResults.flatMap((task) => Option.toArray(Option.map(task.improvement, (value) => ({ ...task, value }))))
  const families = [...new Set(tasks.map((task) => task.family))].map((family) => mean(tasks.filter((task) => task.family === family).map((task) => task.value)))
  const requiredFamilies = Math.max(30, spec.plannedIndependentFamilies)
  const readiness = [
    ...([baseline, candidate].some((run) => run.phase !== "graded") ? ["Execution has not been graded"] : []),
    ...(measured.length !== expected.length ? ["Incomplete paired primary measurements"] : []),
    ...([baseline, candidate].some((run) => run.trials.length !== expected.length || !run.trials.every((trial) => completeGrades(trial, spec))) ? ["Incomplete execution or required-grade coverage"] : []),
    ...([baseline, candidate].some((run) => run.trials.some((trial) => trial.task.review === "provisional")) ? ["Reference labels need review"] : []),
    ...(families.length < requiredFamilies ? [`Independent families ${families.length} below required ${requiredFamilies}`] : []),
  ]
  const improvement = incompatibilities.length || measured.length !== expected.length ? Option.none() : pairedFamilyInterval(families, spec.seed)
  const evidenceIssues = [...readiness, ...(Option.isNone(improvement) && measured.length === expected.length && !incompatibilities.length ? ["Family variation is insufficient for a nondegenerate bootstrap interval"] : [])]
  const verdict: ComparisonReport["verdict"] = incompatibilities.length ? "incompatible" : evidenceIssues.length || Option.isNone(improvement) ? "inconclusive"
    : improvement.value.low > spec.minimumImprovement ? "improved" : improvement.value.high < -spec.minimumImprovement ? "regressed" : "inconclusive"
  const blockingGates = candidateGates(candidate, spec)
  const acceptanceIssues = [...incompatibilities, ...evidenceIssues, ...blockingGates.filter((gate) => !gate.passed).map((gate) => `Blocking gate ${gate.grader}/${gate.metric}: ${gate.reason}`), ...(verdict !== "improved" ? ["The primary interval does not establish the declared practical improvement"] : [])]
  const secondaryUnmeasured = (run: EvaluationRun): number => run.trials.reduce((sum, trial) => sum + trial.task.graders.filter((binding) => !requiredBinding(trial, binding.grader, spec) && trial.grades.filter((grade) => `${grade.grader}@${grade.version}` === binding.grader && grade.scope === binding.scope && grade.status === "scored").length !== 1).length, 0)
  return {
    version: 1, specification: spec.id, specificationFingerprint: comparisonSpecificationFingerprint(spec), baselineRun: baseline.id, candidateRun: candidate.id,
    verdict, accepted: verdict === "improved" && acceptanceIssues.length === 0,
    issues: [...incompatibilities, ...evidenceIssues], acceptanceIssues,
    expectedPairs: expected.length, measuredPairs: measured.length, missingPairs: expected.length - measured.length,
    independentFamilies: families.length, requiredFamilies,
    baselineUnmeasured: paired.filter((pair) => Option.isNone(Option.flatMap(pair.left, (trial) => primaryValue(trial, spec)))).length,
    candidateUnmeasured: paired.filter((pair) => Option.isNone(Option.flatMap(pair.right, (trial) => primaryValue(trial, spec)))).length,
    secondaryUnmeasured: { baseline: secondaryUnmeasured(baseline), candidate: secondaryUnmeasured(candidate) },
    tasks: taskResults, regressions: taskResults.filter((task) => Option.exists(task.improvement, (value) => value < 0)).map((task) => `${task.suiteId}/${task.taskId}`), blockingGates,
    confidenceLevel: 0.95, bootstrapSamples: 10000, seed: spec.seed, improvement,
    minimumImprovement: spec.minimumImprovement, estimand: "equal-family-mean; repetitions-within-task; tasks-within-family",
  }
}
