import { Effect, Option } from "effect"
import { fingerprint } from "./grading-context.entity.functions.js"
import { EvaluationError } from "./identity.entity.js"
import type { Task } from "./task.entity.js"
import type { Suite } from "./suite.entity.js"
import type { EvaluationApp, EvaluationSelection } from "../contracts/evaluation-app.contract.js"
import type { ComparisonExecution, ComparisonSpecification } from "./comparison-specification.entity.js"

export const comparisonTaskFingerprint = (task: Task): string => fingerprint(task)
export const comparisonSpecificationFingerprint = (specification: ComparisonSpecification): string => fingerprint(specification)
export const comparisonGradingFingerprint = (app: EvaluationApp): string => fingerprint({
  graders: app.graders.map((grader) => grader.definition),
  projections: app.projections.map(({ definition }) => definition),
})
export const comparisonGateDefinitions = (suites: ReadonlyArray<Suite>): ComparisonSpecification["gates"] =>
  suites.flatMap((suite) => suite.gates.map((gate) => ({ suiteId: suite.id, gate })))
const sorted = (values: ReadonlyArray<unknown>) => values.map(fingerprint).sort()
export const sameComparisonItems = (left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>): boolean =>
  fingerprint(sorted(left)) === fingerprint(sorted(right))
/** Families are application-wide lineage IDs, including across datasets and suites. */
export const comparisonFamily = (task: Task): string => task.family
export const comparisonTaskKey = (suiteId: string, taskId: string): string => JSON.stringify([suiteId, taskId])
export const comparisonReservedFingerprint = (key: string): boolean => key.startsWith("comparison")
const fixedFingerprint = (key: string) => /^(fixture:|protocol:|gradingConfiguration$|comparison)/u.test(key)
const derivedFingerprint = (key: string) => ["gradingConfiguration", "sourceRun", "sourceExecution"].includes(key) || comparisonReservedFingerprint(key)
export const comparisonSubjectFingerprints = (values: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
  Object.fromEntries(Object.entries(values).filter(([key]) => !derivedFingerprint(key)))
export const comparisonExecutionSettings = (app: EvaluationApp, selection: EvaluationSelection): ComparisonSpecification["execution"] =>
  app.suites.filter((suite) => !selection.ids.length || selection.ids.includes(suite.id)).map((suite) => ({
    suiteId: suite.id, timeoutMs: selection.timeoutMs ?? suite.timeoutMs, concurrency: selection.concurrency ?? suite.concurrency,
    environments: Object.fromEntries(suite.tasks.filter((task) =>
      (!selection.split || selection.split === "all" || task.split === selection.split) &&
      (!selection.tasks?.length || selection.tasks.includes(task.id)),
    ).map((task) => [task.runnable, selection.environment ?? app.environmentFor[task.runnable] ?? ""])),
  }))

/** Semantic checks supplement the boundary codec; task references are fingerprints, never subject input. */
export const comparisonSpecificationIssues = (spec: ComparisonSpecification): ReadonlyArray<string> => {
  const keys = [...new Set([...Object.keys(spec.baseline.fingerprints), ...Object.keys(spec.candidate.fingerprints)])]
  const changes = keys.filter((key) => spec.baseline.fingerprints[key] !== spec.candidate.fingerprints[key])
  const calibrated = Boolean(spec.baseline.fingerprints.calibration) && spec.baseline.fingerprints.calibration === spec.candidate.fingerprints.calibration
  return [
    ...(spec.tasks.length === 0 ? ["The specification needs tasks"] : []),
    ...(new Set(spec.tasks.map((task) => comparisonTaskKey(task.suiteId, task.taskId))).size !== spec.tasks.length ? ["Duplicate specified task"] : []),
    ...(new Set(spec.allowedFingerprintChanges).size !== spec.allowedFingerprintChanges.length ? ["Duplicate allowed fingerprint change"] : []),
    ...(keys.some(derivedFingerprint) ? ["Derived comparison/grading provenance cannot be supplied as subject fingerprints"] : []),
    ...(spec.allowedFingerprintChanges.some((key) => fixedFingerprint(key) || (key.startsWith("calibratedGrader") && !calibrated)) ? ["Labels, fixtures, protocol and assessment policy cannot be allowed to change; target-grader changes require a calibration"] : []),
    ...changes.filter((key) => !spec.allowedFingerprintChanges.includes(key)).map((key) => `Undeclared fingerprint change: ${key}`),
    ...spec.allowedFingerprintChanges.filter((key) => !changes.includes(key)).map((key) => `Allowed fingerprint does not change: ${key}`),
    ...(spec.gates.some((entry) => !spec.tasks.some((task) => task.suiteId === entry.suiteId)) ? ["Gate belongs to an unspecified suite"] : []),
    ...(new Set(spec.execution.map((entry) => entry.suiteId)).size !== spec.execution.length || !sameComparisonItems(spec.execution.map((entry) => entry.suiteId), [...new Set(spec.tasks.map((task) => task.suiteId))]) ? ["Execution settings must describe every specified suite exactly once"] : []),
  ]
}
export const validateComparisonSpecification = (specification: ComparisonSpecification) => {
  const issues = comparisonSpecificationIssues(specification)
  return issues.length ? Effect.fail(new EvaluationError({ code: "invalid", message: issues.join("; ") })) : Effect.succeed(specification)
}

/** Before resource acquisition: bind exactly the declared execution, without changing runnable inputs. */
export const comparisonPreflight = (app: EvaluationApp, selection: EvaluationSelection, execution: ComparisonExecution) =>
  Effect.gen(function* () {
    const spec = yield* validateComparisonSpecification(execution.specification)
    const subject = spec[execution.side]
    const suites = app.suites.filter((suite) => !selection.ids.length || selection.ids.includes(suite.id))
    const tasks = suites.flatMap((suite) => suite.tasks.filter((task) =>
      (!selection.split || selection.split === "all" || task.split === selection.split) &&
      (!selection.tasks?.length || selection.tasks.includes(task.id)),
    ).map((task) => ({ suiteId: suite.id, taskId: task.id, fingerprint: comparisonTaskFingerprint(task) })))
    const candidates = suites.flatMap((suite) => suite.candidates.filter((candidate) => !selection.candidates?.length || selection.candidates.includes(candidate.id)))
    const issues = [
      ...(selection.ids.some((id) => !suites.some((suite) => suite.id === id)) ? ["Unknown suite selection"] : []),
      ...(selection.tasks?.some((id) => !tasks.some((task) => task.taskId === id)) ? ["Unknown task selection"] : []),
      ...(selection.candidates?.some((id) => !candidates.some((candidate) => candidate.id === id)) ? ["Unknown candidate selection"] : []),
      ...(comparisonExecutionSettings(app, selection).some((entry) => Object.entries(entry.environments).some(([id, environment]) => !app.runnables.some((runnable) => runnable.definition.id === id && runnable.environments.some((item) => item.id === environment)))) ? ["Unregistered comparison environment"] : []),
      ...(app.id !== spec.application ? ["Application differs from specification"] : []),
      ...(!sameComparisonItems(tasks, spec.tasks) ? ["Selected tasks, labels, split or family differs from specification"] : []),
      ...(!candidates.length || candidates.some((candidate) => fingerprint(candidate) !== fingerprint(subject.candidate)) ? ["Select exactly the frozen candidate configuration"] : []),
      ...(suites.some((suite) => (selection.repetitions ?? suite.repetitions) !== spec.repetitions) ? ["Repetitions differ from specification"] : []),
      ...(fingerprint(app.fingerprints) !== fingerprint(subject.fingerprints) ? ["Subject run fingerprints differ from specification"] : []),
      ...(comparisonGradingFingerprint(app) !== spec.gradingConfiguration ? ["Assessment configuration differs from specification"] : []),
      ...(!sameComparisonItems(comparisonGateDefinitions(suites), spec.gates) ? ["Gate definitions differ from specification"] : []),
      ...(!sameComparisonItems(comparisonExecutionSettings(app, selection), spec.execution) ? ["Environment, timeout or concurrency differs from specification"] : []),
      ...(suites.some((suite) => suite.tasks.filter((task) => tasks.some((entry) => entry.suiteId === suite.id && entry.taskId === task.id)).some((task) => !task.graders.some((binding) => binding.grader === spec.primary.grader))) ? ["Every specified task must bind the primary grader"] : []),
      ...(!app.graders.some((grader) => `${grader.definition.id}@${grader.definition.version}` === spec.primary.grader && grader.definition.metrics.includes(spec.primary.metric)) ? ["Primary grader metric is not registered"] : []),
    ]
    if (issues.length) return yield* Effect.fail(new EvaluationError({ code: "invalid", message: issues.join("; ") }))
    return {
      ...app.fingerprints,
      comparisonSpecification: comparisonSpecificationFingerprint(spec),
      comparisonSide: execution.side,
      comparisonGates: fingerprint(sorted(spec.gates)),
      comparisonGrading: spec.gradingConfiguration,
      comparisonExecution: fingerprint(sorted(spec.execution)),
    }
  })

export const comparisonExecutionFingerprints = (app: EvaluationApp, selection: EvaluationSelection) =>
  Option.match(Option.fromNullishOr(selection.comparison), {
    onNone: () => Object.keys(app.fingerprints).some(comparisonReservedFingerprint)
      ? Effect.fail(new EvaluationError({ code: "invalid", message: "Comparison provenance requires a preflight specification" }))
      : Effect.succeed(app.fingerprints),
    onSome: (execution) => comparisonPreflight(app, selection, execution),
  })
