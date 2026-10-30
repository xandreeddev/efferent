import { Array as Arr, Option, Order } from "effect"
import type { EvaluationRun } from "./evaluation-run.entity.js"
import type { Suite } from "./suite.entity.js"
import type { Trial } from "./trial.entity.js"
import { fingerprint } from "./grading-context.entity.functions.js"
import { numericMetric } from "../assessment.entity.functions.js"

/** @public */
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
  const bounded = Option.isSome(gate.minimum) || Option.isSome(gate.maximum)
  const passed = bounded && reviewed && complete && Option.isSome(value) && Option.match(gate.minimum, { onNone: () => true, onSome: (minimum) => value.value >= minimum }) && Option.match(gate.maximum, { onNone: () => true, onSome: (maximum) => value.value <= maximum })
  return { candidate: candidate.id, grader: gate.grader, metric: gate.metric, mode: gate.mode, passed, measured: values.length, value, reason: !bounded ? "Gate has no minimum or maximum" : !reviewed ? "Reference labels need review" : !complete ? "Incomplete trial or measurement coverage" : passed ? "Passed" : "Outside threshold" }
})))

/** What a trial measured, apart from the candidate it measured. */
const trialIdentity = (trial: Trial) => `${trial.suiteId}/${trial.task.id}/${trial.task.version}/${trial.task.datasetVersion}/${trial.task.provenance}/${fingerprint({ input: trial.task.input, reference: trial.task.reference })}/${trial.sample}`
/** Distinct keys in code-unit order: the same lines whatever order the trials ran in. */
const canonical = (keys: ReadonlyArray<string>) => Arr.sort(Arr.dedupe(keys), Order.String).join("\n")
const identities = (run: EvaluationRun) => canonical(run.trials.map(trialIdentity))
/** Each trial's identity with its grader bindings, the bindings in code-unit order. */
const coverage = (run: EvaluationRun) => canonical(run.trials.map((trial) =>
  `${trialIdentity(trial)}:${Arr.sort(trial.task.graders.map((binding) => fingerprint(binding)), Order.String).join(",")}`))

export const comparisonIssues = (baseline: EvaluationRun, candidate: EvaluationRun): ReadonlyArray<string> => {
  return [
    ...([baseline, candidate].some((run) => run.phase !== "graded") ? ["Execution has not been graded"] : []),
    ...(baseline.fingerprints.gradingConfiguration !== candidate.fingerprints.gradingConfiguration ? ["Grader definitions or projection policy differs"] : []),
    ...(baseline.application !== candidate.application ? ["Different applications"] : []),
    ...(identities(baseline) !== identities(candidate) ? ["Task, dataset or repetition coverage differs"] : []),
    ...(Object.entries(baseline.fingerprints).filter(([key]) => key.startsWith("fixture:") || key.startsWith("protocol:")).some(([key, value]) => candidate.fingerprints[key] !== value) ? ["Fixture or protocol provenance differs"] : []),
    ...(coverage(baseline) !== coverage(candidate) ? ["Grader or projection coverage differs"] : []),
    ...([baseline, candidate].some((run) => run.trials.some((trial) => trial.status !== "completed" || trial.grades.some((grade) => grade.status !== "scored") || trial.task.graders.some((binding) => !trial.grades.some((grade) => `${grade.grader}@${grade.version}` === binding.grader && grade.scope === binding.scope && grade.status === "scored")))) ? ["Incomplete trials or grade coverage"] : []),
  ]
}
