import { expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import {
  defineGraderCalibration, defineEvaluationApp, EvalId, GraderAssessment, EvaluationError,
  EvaluationServicesLive, EvaluationRunStore, runEvaluation, gradeEvaluation, executionFingerprint,
  runGates, validateEvaluationApp, unknownEvaluationUsage, calibrateGrader, CalibrationReference, CalibrationObservation,
  calibrationApplication, comparisonGradingFingerprint, comparisonPreflight, comparisonTaskFingerprint,
  comparisonGateDefinitions, comparisonExecutionSettings, type ComparisonSpecification,
} from "../index.js"
import { fixture } from "./fixture.testing.js"

const Input = Schema.Struct({ evidence: Schema.OptionFromNullOr(Schema.Boolean) })
const target = {
  definition: { id: EvalId.make("evidence-grader"), version: "1", kind: "code" as const, metrics: ["valid"], fingerprints: {} },
  layer: Layer.succeed(GraderAssessment, {
    assess: (context) => Schema.decodeUnknownEffect(Input)(context.input).pipe(
      Effect.mapError((error) => new EvaluationError({ code: "invalid", message: String(error) })),
      Effect.flatMap(({ evidence }) => Option.match(evidence, {
        onNone: () => Effect.fail(new EvaluationError({ code: "unavailable", message: "Missing evidence" })),
        onSome: (value) => Effect.succeed({ status: "scored" as const, metrics: [{ kind: "boolean" as const, name: "valid", value }], reason: "Observed", usage: unknownEvaluationUsage, metadata: {} }),
      })),
    ),
  }),
}
const calibration = defineGraderCalibration({ id: "calibration", version: "1", description: "Evidence boundary", input: Input, grader: target,
  cases: [true, false, null].map((value, index) => ({
    id: `case-${index}`, family: `family-${index}`, split: index === 2 ? "validation" as const : "calibration" as const,
    review: "known" as const, provenance: "Controlled evidence mutation", input: { evidence: Option.fromNullishOr(value) },
    reference: { status: value === null ? "unavailable" as const : "scored" as const,
      metrics: value === null ? [] : [{ metric: { kind: "boolean" as const, name: "valid", value }, tolerance: 0 }] },
  })),
})
const app = defineEvaluationApp({ id: "calibration-test", suites: [], calibrations: [calibration.calibration],
  runnables: [calibration.runnable], graders: calibration.graders, projections: calibration.projections,
  environmentFor: { [calibration.runnable.definition.id]: calibration.environment.id }, fingerprints: {}, commands: {},
})
const store = Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, writeRun: () => Effect.void })
test("the actual grader is calibrated on passes, rejections and unavailable evidence; labels stay outside execution", async () => {
  const report = await Effect.runPromise(calibrateGrader(app, "calibration", "cal", { ids: [], split: "all" }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(app), store))))
  expect(report.trials).toHaveLength(3)
  expect(report.gates.every((gate) => gate.passed)).toBe(true)
  expect(report.trials.map((trial) => Schema.decodeUnknownSync(CalibrationObservation)(Option.getOrThrow(trial.output)).status)).toEqual(["scored", "scored", "unavailable"])
  expect(report.trials.every((trial) => !JSON.stringify(trial.transcript).includes('"reference":'))).toBe(true)
  const replay = await Effect.runPromise(gradeEvaluation(app, report, "replay").pipe(Effect.provide(Layer.merge(EvaluationServicesLive(app), store))))
  expect(executionFingerprint(replay)).toBe(executionFingerprint(report))
  expect(replay.gates.every((gate) => gate.passed)).toBe(true)
})
test("a permissive mutation cannot pass calibration", async () => {
  const mutated = defineGraderCalibration({ id: "mutation", version: "1", description: "Always accepts", input: Input,
    grader: { ...target, layer: Layer.succeed(GraderAssessment, { assess: () => Effect.succeed({ status: "scored", metrics: [{ kind: "boolean", name: "valid", value: true }], reason: "Always accepts", usage: unknownEvaluationUsage, metadata: {} }) }) },
    cases: calibration.calibration.suite.tasks.map((task) => ({ ...task, split: task.split === "calibration" ? "calibration" as const : "validation" as const, input: Schema.decodeUnknownSync(Schema.toCodecJson(Input))(task.input), reference: Schema.decodeUnknownSync(CalibrationReference)(task.reference) })),
  })
  const mutatedApp = { ...app, calibrations: [mutated.calibration], runnables: [mutated.runnable], graders: mutated.graders, projections: mutated.projections, environmentFor: { [mutated.runnable.definition.id]: mutated.environment.id } }
  const report = await Effect.runPromise(calibrateGrader(mutatedApp, "mutation", "mutation", { ids: [], split: "all" }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(mutatedApp), store))))
  expect(report.gates.filter((gate) => gate.passed)).toHaveLength(1)
  expect(report.gates.find((gate) => gate.metric === "false-pass")?.passed).toBe(false)
})

test("a duplicate grade cannot stand in for a missing scoped grade", async () => {
  const original = fixture()
  const report = await Effect.runPromise(runEvaluation(original, "gates", { ids: [], split: "validation" }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(original), store))))
  const trial = report.trials[0]!
  const first = trial.task.graders[0]!
  const altered = { ...trial, task: { ...trial.task, graders: [first, { ...first, scope: "missing" }] }, grades: [trial.grades[0]!, trial.grades[0]!] }
  const gates = runGates(original.suites, [altered])
  expect(gates[0]?.passed).toBe(false)
  expect(gates[0]?.measured).toBe(0)
})
test("validation rejects unbound gates, duplicate scopes and family leakage", async () => {
  const base = fixture()
  const suite = base.suites[0]!
  const task = suite.tasks[0]!
  await Promise.all([
    { ...suite, tasks: [{ ...task, graders: [] }] },
    { ...suite, tasks: [{ ...task, graders: [task.graders[0]!, task.graders[0]!] }] },
    { ...suite, tasks: [task, { ...task, id: EvalId.make("other"), split: "calibration" }] },
  ].map(async (invalid) => expect(await Effect.runPromise(validateEvaluationApp({ ...base, suites: [invalid] }).pipe(Effect.isFailure))).toBe(true)))
})

test("a target grader revision can be compared while its labels and agreement grader remain fixed", async () => {
  const changed = defineGraderCalibration({ id: "calibration", version: "1", description: "Evidence boundary", input: Input,
    grader: { ...target, definition: { ...target.definition, version: "2", fingerprints: { prompt: "revised" } } },
    cases: calibration.calibration.suite.tasks.map((task) => ({ ...task, split: task.split === "calibration" ? "calibration" as const : "validation" as const,
      input: Schema.decodeUnknownSync(Schema.toCodecJson(Input))(task.input), reference: Schema.decodeUnknownSync(CalibrationReference)(task.reference),
    })),
  })
  const changedApp = { ...app, calibrations: [changed.calibration], runnables: [changed.runnable], graders: changed.graders, projections: changed.projections }
  const [before, after] = await Effect.runPromise(Effect.all([calibrationApplication(app, "calibration"), calibrationApplication(changedApp, "calibration")]))
  expect(comparisonGradingFingerprint(before)).toBe(comparisonGradingFingerprint(after))
  const selection = { ids: ["calibration"], split: "all" }
  const spec: ComparisonSpecification = {
    version: 1, id: EvalId.make("judge-revision"), application: app.id, hypothesis: "Revised target judge improves agreement.",
    baseline: { candidate: before.suites[0]!.candidates[0]!, fingerprints: before.fingerprints },
    candidate: { candidate: after.suites[0]!.candidates[0]!, fingerprints: after.fingerprints },
    allowedFingerprintChanges: ["calibratedGrader", "calibratedGrader:prompt"],
    tasks: before.suites[0]!.tasks.map((task) => ({ suiteId: before.suites[0]!.id, taskId: task.id, fingerprint: comparisonTaskFingerprint(task) })),
    repetitions: 1, execution: comparisonExecutionSettings(before, selection), gradingConfiguration: comparisonGradingFingerprint(before), gates: comparisonGateDefinitions(before.suites),
    primary: { grader: "calibration.agreement@1", metric: "agreement", direction: "higher" }, minimumImprovement: 0.05,
    plannedIndependentFamilies: 30, targetPower: 0.8, powerRationale: "Fixture validates wiring, not power; only three families must remain inconclusive.", seed: 1,
  }
  expect(await Effect.runPromise(comparisonPreflight(before, selection, { specification: spec, side: "baseline" }).pipe(Effect.isSuccess))).toBe(true)
  expect(await Effect.runPromise(comparisonPreflight(after, selection, { specification: spec, side: "candidate" }).pipe(Effect.isSuccess))).toBe(true)
  const run = await Effect.runPromise(calibrateGrader(changedApp, "calibration", "changed", { ...selection, comparison: { specification: spec, side: "candidate" } }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(changedApp), store))))
  expect(run.fingerprints.comparisonSide).toBe("candidate")
})
