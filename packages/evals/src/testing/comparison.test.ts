import { expect, test } from "bun:test"
import { Effect, Layer, Option, Ref } from "effect"
import { compareEvaluations, pairedFamilyInterval } from "../domain/comparison-report.entity.functions.js"
import { comparisonFixture } from "./comparison-fixture.testing.js"
import { comparisonPreflight, comparisonSpecificationIssues, comparisonTaskFingerprint } from "../domain/comparison-specification.entity.functions.js"
import { fingerprint } from "../domain/grading-context.entity.functions.js"
import { runEvaluation, gradeEvaluation } from "../usecases/run-evaluation.usecase.functions.js"
import { EvaluationRunStore } from "../ports/evaluation-store.port.js"
import { EvaluationServicesLive } from "../adapters/evaluation-services.adapter.js"
import { FixtureRunnable, fixtureRegistration } from "./fixture.testing.js"

test("prospective reports require complete reviewed paired evidence and a practical lower bound", async () => {
  const f = comparisonFixture()
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline"), f.report("candidate")]))
  const result = compareEvaluations(base, next, f.specification)
  expect(result).toMatchObject({ verdict: "improved", accepted: true, independentFamilies: 30, measuredPairs: 60, missingPairs: 0 })
  expect(Option.getOrThrow(result.improvement).low).toBeGreaterThan(f.specification.minimumImprovement)
  expect(compareEvaluations(base, next, f.specification)).toEqual(result)
  expect(compareEvaluations(base, { ...next, fingerprints: { ...next.fingerprints, comparisonSpecification: "retrofitted" } }, f.specification).verdict).toBe("incompatible")
})

test("small mean improvements, lower-is-better outcomes and regressions use the declared direction", async () => {
  const f = comparisonFixture()
  const spec = { ...f.specification, primary: { ...f.specification.primary, direction: "lower" as const } }
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline", spec, () => 0.9), f.report("candidate", spec)]))
  expect(compareEvaluations(base, next, spec).verdict).toBe("improved")
  const worse = await Effect.runPromise(f.report("baseline", spec, () => 0.4))
  const regressed = compareEvaluations(worse, next, spec)
  expect(regressed.verdict).toBe("regressed")
  expect(regressed.regressions).toHaveLength(30)
  const marginal = await Effect.runPromise(f.report("baseline", spec, () => 0.84))
  expect(compareEvaluations(marginal, next, spec).verdict).toBe("inconclusive")
})

test("missing or duplicate pairs and changed labels never produce synthetic zero scores", async () => {
  const f = comparisonFixture()
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline"), f.report("candidate")]))
  const missing = compareEvaluations(base, { ...next, trials: next.trials.slice(1) }, f.specification)
  expect(missing).toMatchObject({ verdict: "inconclusive", missingPairs: 1, candidateUnmeasured: 1 })
  expect(Option.isNone(missing.improvement)).toBe(true)
  expect(compareEvaluations(base, { ...next, trials: [...next.trials, next.trials[0]!] }, f.specification).verdict).toBe("incompatible")
  expect(compareEvaluations(base, { ...next, trials: next.trials.map((trial) => ({ ...trial, task: { ...trial.task, reference: "corrected after exposure" } })) }, f.specification).verdict).toBe("incompatible")
  const unavailable = compareEvaluations(base, { ...next, trials: next.trials.map((trial, index) => index ? trial : { ...trial, grades: trial.grades.map((grade) => ({ ...grade, status: "unavailable", metrics: [] })) }) }, f.specification)
  expect(unavailable.candidateUnmeasured).toBe(1)
  expect(unavailable.verdict).toBe("inconclusive")
})

test("repetitions, translations and shared family IDs across datasets cannot manufacture sample size", async () => {
  const f = comparisonFixture(60, 3, (task, index) => ({ ...task, family: `family-${index % 10}`, dataset: index < 30 ? "source-a" : "source-b" }))
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline"), f.report("candidate")]))
  expect(compareEvaluations(base, next, f.specification)).toMatchObject({ verdict: "inconclusive", independentFamilies: 10, requiredFamilies: 30, measuredPairs: 180 })
})

test("each family has equal weight after averaging repetitions within each task", async () => {
  const f = comparisonFixture(39, 2, (task, index) => ({ ...task, family: index < 10 ? "large-family" : `family-${index}` }))
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline", f.specification, () => 0), f.report("candidate", f.specification, (index, sample) => index < 10 ? sample / 10 : 0.6)]))
  const result = compareEvaluations(base, next, f.specification)
  expect(Option.getOrThrow(result.improvement).estimate).toBeCloseTo((0.15 + 29 * 0.6) / 30)
  expect(result.independentFamilies).toBe(30)
  expect(result.tasks[0]?.improvement).toEqual(Option.some(0.15000000000000002))
})

test("insufficient planned sample size and degenerate intervals remain inconclusive", async () => {
  const f = comparisonFixture()
  const planned = { ...f.specification, plannedIndependentFamilies: 45 }
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline", planned), f.report("candidate", planned)]))
  expect(compareEvaluations(base, next, planned)).toMatchObject({ verdict: "inconclusive", requiredFamilies: 45 })
  const constant = await Effect.runPromise(f.report("candidate", planned, () => 0.8))
  expect(Option.isNone(compareEvaluations(base, constant, planned).improvement)).toBe(true)
  expect(Option.isNone(pairedFamilyInterval([0.2, 0.2], 1))).toBe(true)
  expect(Option.isNone(pairedFamilyInterval([0.2], 1))).toBe(true)
})

test("fixed blocking gates control acceptance separately from the primary comparison", async () => {
  const f = comparisonFixture()
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline", f.specification, () => 0.1), f.report("candidate", f.specification, (index) => 0.4 + index / 1000)]))
  const result = compareEvaluations(base, next, f.specification)
  expect(result.verdict).toBe("improved")
  expect(result.accepted).toBe(false)
  expect(result.blockingGates.some((gate) => !gate.passed)).toBe(true)
})

test("optional secondary grader failures remain visible without changing primary completeness", async () => {
  const f = comparisonFixture(30, 2, (task) => ({ ...task, graders: [...task.graders, { grader: "secondary@1", projection: "projection", scope: "trial" }] }))
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline"), f.report("candidate")]))
  const withoutSecondary = { ...next, trials: next.trials.map((trial) => ({ ...trial, grades: trial.grades.filter((grade) => grade.grader !== "secondary") })) }
  const result = compareEvaluations(base, withoutSecondary, f.specification)
  expect(result).toMatchObject({ verdict: "improved", accepted: true, secondaryUnmeasured: { baseline: 0, candidate: 60 } })
})

test("provisional references cannot support confirmation and metric scale changes are incompatible", async () => {
  const f = comparisonFixture(30, 2, (task) => ({ ...task, review: "provisional" }))
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline"), f.report("candidate")]))
  expect(compareEvaluations(base, next, f.specification)).toMatchObject({ verdict: "inconclusive", accepted: false })
  const scaled = { ...next, trials: next.trials.map((trial) => ({ ...trial, grades: trial.grades.map((grade) => ({ ...grade, metrics: [{ kind: "score" as const, name: "correct", value: 90, min: 0, max: 100 }] })) })) }
  expect(compareEvaluations(base, scaled, f.specification).verdict).toBe("incompatible")
})

test("practical margins are evaluated in raw score units on narrow and wide scales", async () => {
  const f = comparisonFixture()
  const [base, next] = await Effect.runPromise(Effect.all([f.report("baseline"), f.report("candidate")]))
  const scale = (run: typeof base, factor: number) => ({ ...run, trials: run.trials.map((trial) => ({ ...trial, grades: trial.grades.map((grade) => ({ ...grade, metrics: grade.metrics.map((metric) => metric.kind === "score" ? { ...metric, value: metric.value * factor, min: metric.min * factor, max: metric.max * factor } : metric) })) })) })
  const narrow = compareEvaluations(scale(base, 0.1), scale(next, 0.1), f.specification)
  expect(narrow).toMatchObject({ verdict: "inconclusive", accepted: false })
  expect(Option.getOrThrow(narrow.improvement).estimate).toBeCloseTo(0.04145)
  const wide = compareEvaluations(scale(base, 100), scale(next, 100), f.specification)
  expect(wide.verdict).toBe("improved")
  expect(Option.getOrThrow(wide.improvement).estimate).toBeCloseTo(41.45)
})

test("specification and preflight reject undeclared changes, settings drift and stale references before execution", async () => {
  const f = comparisonFixture()
  expect(comparisonSpecificationIssues({ ...f.specification, allowedFingerprintChanges: [] })).toContain("Undeclared fingerprint change: application")
  expect(comparisonSpecificationIssues({ ...f.specification, allowedFingerprintChanges: ["application", "fixture:content"] }).length).toBeGreaterThan(0)
  const execution = { specification: f.specification, side: "baseline" as const }
  expect(await Effect.runPromise(comparisonPreflight(f.base, { ...f.selection, timeoutMs: 2000 }, execution).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(comparisonPreflight(f.base, { ...f.selection, concurrency: 2 }, execution).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(comparisonPreflight(f.base, { ...f.selection, environment: "other" }, execution).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(comparisonPreflight(f.base, { ...f.selection, tasks: ["task-0"] }, execution).pipe(Effect.isFailure))).toBe(true)
  const task = f.base.suites[0]!.tasks[0]!
  expect(comparisonTaskFingerprint({ ...task, family: "changed" })).not.toBe(comparisonTaskFingerprint(task))
})

test("run preflight precedes subject services and never leaks references or the specification", async () => {
  const f = comparisonFixture()
  const calls = await Effect.runPromise(Ref.make(0))
  const app = { ...f.base, runnables: [fixtureRegistration(Layer.succeed(FixtureRunnable, {
    execute: (input, candidate, world) => Effect.gen(function* () {
      expect(JSON.stringify({ input, candidate, world })).not.toContain("secret-label")
      expect(JSON.stringify({ input, candidate, world })).not.toContain("powerRationale")
      yield* Ref.update(calls, (count) => count + 1)
      return { output: "answer", evidence: {} }
    }),
  }))] }
  const provide = <A, E>(effect: Effect.Effect<A, E, EvaluationRunStore | import("../ports/evaluation-services.port.js").EvaluationServices>) => effect.pipe(
    Effect.provide(EvaluationServicesLive(app)), Effect.provide(Layer.succeed(EvaluationRunStore, { writeRun: () => Effect.void, writeTrial: () => Effect.void })),
  )
  const comparison = { specification: f.specification, side: "baseline" as const }
  expect(await Effect.runPromise(provide(runEvaluation(app, "invalid", { ...f.selection, comparison, timeoutMs: 3000 })).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(Ref.get(calls))).toBe(0)
  const executed = await Effect.runPromise(provide(runEvaluation(app, "valid", { ...f.selection, comparison, executeOnly: true })))
  expect(executed.fingerprints.comparisonSpecification).toBe(fingerprint(f.specification))
  expect(await Effect.runPromise(Ref.get(calls))).toBe(60)
  const graded = await Effect.runPromise(provide(gradeEvaluation(app, executed, "graded")))
  expect(graded.fingerprints.comparisonSpecification).toBe(executed.fingerprints.comparisonSpecification)
  expect(await Effect.runPromise(Ref.get(calls))).toBe(60)
})
