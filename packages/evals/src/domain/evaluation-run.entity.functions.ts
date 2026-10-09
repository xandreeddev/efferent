import { Option } from "effect"
import type { EvaluationRun } from "./evaluation-run.entity.js"
import type { Suite } from "./suite.entity.js"
import { fingerprint } from "./grading-context.entity.functions.js"
import { numericMetric } from "../assessment.entity.functions.js"

export const runGates = (suites: ReadonlyArray<Suite>, trials: EvaluationRun["trials"]): EvaluationRun["gates"] => suites.flatMap((suite) => suite.candidates.flatMap((candidate) => suite.gates.map((gate) => {
  const relevant = trials.filter((trial) => trial.suiteId === suite.id && trial.candidate.id === candidate.id && trial.task.graders.some((binding) => binding.grader === gate.grader))
  const values = relevant.flatMap((trial) => {
    if (trial.status !== "completed") return []
    const bindings = trial.task.graders.filter((binding) => binding.grader === gate.grader)
    const scores = bindings.map((binding) => {
      const grades = trial.grades.filter((grade) => `${grade.grader}@${grade.version}` === binding.grader && grade.scope === binding.scope)
      const metrics = grades.flatMap((grade) => grade.status === "scored" ? grade.metrics.filter((metric) => metric.name === gate.metric) : [])
      return grades.length === 1 && metrics.length === 1 ? numericMetric(metrics[0]!) : Option.none<number>()
    })
    return scores.length > 0 && scores.every(Option.isSome)
      ? [scores.flatMap(Option.toArray).reduce((sum, score) => sum + score, 0) / scores.length] : []
  })
  const value = values.length ? Option.some(gate.aggregate === "mean" ? values.reduce((sum, item) => sum + item, 0) / values.length : values.filter((item) => item === 1).length / relevant.length) : Option.none<number>()
  const reviewed = !gate.requiresReviewedReference || relevant.every((trial) => trial.task.review !== "provisional")
  const complete = relevant.length > 0 && relevant.every((trial) => trial.status === "completed") && values.length === relevant.length
  const passed = reviewed && complete && Option.isSome(value) && Option.match(gate.minimum, { onNone: () => true, onSome: (minimum) => value.value >= minimum }) && Option.match(gate.maximum, { onNone: () => true, onSome: (maximum) => value.value <= maximum })
  return { candidate: candidate.id, grader: gate.grader, metric: gate.metric, mode: gate.mode, passed, measured: values.length, value, reason: !reviewed ? "Reference labels need review" : !complete ? "Incomplete trial or measurement coverage" : passed ? "Passed" : "Outside threshold" }
})))

export const comparisonIssues = (baseline: EvaluationRun, candidate: EvaluationRun): ReadonlyArray<string> => {
  const identities = (run: EvaluationRun) => [...new Set(run.trials.map((trial) => `${trial.suiteId}/${trial.task.id}/${trial.task.version}/${trial.task.datasetVersion}/${trial.task.provenance}/${fingerprint({ input: trial.task.input, reference: trial.task.reference })}/${trial.sample}`))].sort().join("\n")
  return [
    ...([baseline, candidate].some((run) => run.phase !== "graded") ? ["Execution has not been graded"] : []),
    ...(baseline.fingerprints.gradingConfiguration !== candidate.fingerprints.gradingConfiguration ? ["Grader definitions or projection policy differs"] : []),
    ...(baseline.application !== candidate.application ? ["Different applications"] : []),
    ...(identities(baseline) !== identities(candidate) ? ["Task, dataset or repetition coverage differs"] : []),
    ...(Object.entries(baseline.fingerprints).filter(([key]) => key.startsWith("fixture:") || key.startsWith("protocol:")).some(([key, value]) => candidate.fingerprints[key] !== value) ? ["Fixture or protocol provenance differs"] : []),
    ...(JSON.stringify(baseline.trials.map((trial) => trial.task.graders).sort()) !== JSON.stringify(candidate.trials.map((trial) => trial.task.graders).sort()) ? ["Grader or projection coverage differs"] : []),
    ...([baseline, candidate].some((run) => run.trials.some((trial) => trial.status !== "completed" || trial.grades.some((grade) => grade.status !== "scored") || trial.task.graders.some((binding) => !trial.grades.some((grade) => `${grade.grader}@${grade.version}` === binding.grader && grade.scope === binding.scope && grade.status === "scored")))) ? ["Incomplete trials or grade coverage"] : []),
  ]
}
