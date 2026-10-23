import { expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import {
  EvalId, GraderAssessment, EvaluationRunStore, EvaluationServicesLive,
  validateMetrics, validateEvaluationApp, runEvaluation, calibrateGrader,
  defineGraderCalibration, unknownEvaluationUsage, CalibrationObservation,
  comparisonGradingFingerprint, compareEvaluations, type Metric, type EvaluationApp,
} from "../index.js"
import { fixture } from "./fixture.testing.js"
import { comparisonFixture } from "./comparison-fixture.testing.js"

const observed: Metric = { kind: "boolean", name: "correct", value: true }
const store = Layer.succeed(EvaluationRunStore, { writeRun: () => Effect.void, writeTrial: () => Effect.void })
const run = (app: EvaluationApp) => runEvaluation(app, "optional", { ids: [], split: "validation" }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(app), store)))

test("metric optionality allows only declared absences, never missing required or unknown values", async () => {
  expect(await Effect.runPromise(validateMetrics([observed], ["correct", "precision"], ["precision"]).pipe(Effect.isSuccess))).toBe(true)
  expect(await Effect.runPromise(validateMetrics([observed], ["correct", "precision"]).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(validateMetrics([], ["correct", "precision"], ["precision"]).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(validateMetrics([{ ...observed, name: "invented" }], ["correct", "precision"], ["precision"]).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(validateMetrics([observed, observed], ["correct", "precision"], ["precision"]).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(validateMetrics([observed], ["correct"], ["unknown"]).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(validateMetrics([observed], ["correct"], ["correct", "correct"]).pipe(Effect.isFailure))).toBe(true)
})

test("native grading preserves absent optional metrics while strict old declarations still fail", async () => {
  const original = fixture()
  const grader = original.graders[0]!
  const optional = { ...original, graders: [{ ...grader, definition: { ...grader.definition, metrics: ["correct", "precision"], optionalMetrics: ["precision"] } }] }
  const accepted = await Effect.runPromise(run(optional))
  expect(accepted.trials[0]!.grades[0]!.status).toBe("scored")
  expect(accepted.trials[0]!.grades[0]!.metrics).toEqual([observed])
  const strict = await Effect.runPromise(run({ ...original, graders: [{ ...grader, definition: { ...grader.definition, metrics: ["correct", "precision"] } }] }))
  expect(strict.trials[0]!.grades[0]!.status).toBe("error")
  expect(strict.trials[0]!.grades[0]!.metrics).toEqual([])
  const invalid = (optionalMetrics: ReadonlyArray<string>) => ({ ...original, graders: [{ ...grader, definition: { ...grader.definition, optionalMetrics } }] })
  expect(await Effect.runPromise(validateEvaluationApp(invalid(["unknown"])).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(validateEvaluationApp(invalid(["correct", "correct"])).pipe(Effect.isFailure))).toBe(true)
})

const calibrationApp = (optionalMetrics: ReadonlyArray<string>, metrics: ReadonlyArray<Metric>): EvaluationApp => {
  const calibrated = defineGraderCalibration({
    id: "optional-calibration", version: "1", description: "Controlled metric applicability", input: Schema.String,
    grader: {
      definition: { id: EvalId.make("target"), version: "1", kind: "code", metrics: ["correct", "precision"], optionalMetrics, fingerprints: {} },
      layer: Layer.succeed(GraderAssessment, { assess: () => Effect.succeed({ status: "scored", metrics, reason: "Controlled observation", usage: unknownEvaluationUsage, metadata: {} }) }),
    },
    cases: ["calibration", "validation"].map((split, index) => ({ id: `case-${index}`, family: `family-${index}`, split: split === "validation" ? "validation" : "calibration",
      review: "known", provenance: "Controlled applicability fixture", input: "evidence", reference: { status: "scored", metrics: [{ metric: observed, tolerance: 0 }] },
    })),
  })
  return { id: "optional-calibration", suites: [], calibrations: [calibrated.calibration], runnables: [calibrated.runnable], graders: calibrated.graders,
    projections: calibrated.projections, environmentFor: { [calibrated.runnable.definition.id]: calibrated.environment.id }, fingerprints: {}, commands: {},
  }
}

test("calibration validates the target's metric contract before recording observations", async () => {
  const capture = (app: EvaluationApp) => calibrateGrader(app, "optional-calibration", "capture", { ids: [], split: "all" }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(app), store)))
  const optional = await Effect.runPromise(capture(calibrationApp(["precision"], [observed])))
  const strict = await Effect.runPromise(capture(calibrationApp([], [observed])))
  const invented = await Effect.runPromise(capture(calibrationApp(["precision"], [observed, { ...observed, name: "invented" }])))
  const output = (report: typeof optional) => Schema.decodeUnknownSync(CalibrationObservation)(Option.getOrThrow(report.trials[0]!.output))
  expect(output(optional)).toMatchObject({ status: "scored", metrics: [observed] })
  expect(optional.gates.every((gate) => gate.passed)).toBe(true)
  expect(output(strict)).toMatchObject({ status: "error", metrics: [] })
  expect(output(invented)).toMatchObject({ status: "error", metrics: [] })
  expect(strict.gates.some((gate) => !gate.passed)).toBe(true)
  expect(invented.gates.some((gate) => !gate.passed)).toBe(true)
})

test("an absent optional primary metric remains unmeasured and cannot confirm an improvement", async () => {
  const f = comparisonFixture()
  const optionalApp = { ...f.base, graders: f.base.graders.map((grader) => ({ ...grader, definition: { ...grader.definition, optionalMetrics: ["correct"] },
    layer: Layer.succeed(GraderAssessment, { assess: () => Effect.succeed({ status: "scored", metrics: [], reason: "Metric is inapplicable", usage: unknownEvaluationUsage, metadata: {} }) }),
  })) }
  const spec = { ...f.specification, baseline: { candidate: optionalApp.suites[0]!.candidates[0]!, fingerprints: optionalApp.fingerprints }, candidate: { candidate: optionalApp.suites[0]!.candidates[0]!, fingerprints: optionalApp.fingerprints }, allowedFingerprintChanges: [], gradingConfiguration: comparisonGradingFingerprint(optionalApp) }
  const execute = (side: "baseline" | "candidate") => runEvaluation(optionalApp, side, { ...f.selection, comparison: { specification: spec, side } }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(optionalApp), store)))
  const [baseline, candidate] = await Effect.runPromise(Effect.all([execute("baseline"), execute("candidate")]))
  expect(candidate.trials.every((trial) => trial.grades[0]!.status === "scored" && trial.grades[0]!.metrics.length === 0)).toBe(true)
  const report = compareEvaluations(baseline, candidate, spec)
  expect(report).toMatchObject({ verdict: "inconclusive", accepted: false, measuredPairs: 0, missingPairs: 60 })
  expect(Option.isNone(report.improvement)).toBe(true)
})
