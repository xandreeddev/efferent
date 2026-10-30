import { expect, test } from "bun:test"
import { Effect, Layer, Option, Schema } from "effect"
import {
  defineGraderCalibration, defineEvaluationApp, EvalId, GraderAssessment, EvaluationError,
  EvaluationServicesLive, EvaluationRunStore, runEvaluation, gradeEvaluation, executionFingerprint,
  runGates, parseEvaluationApp, unknownEvaluationUsage, calibrateGrader, CalibrationReference, CalibrationObservation,
  compareMetric, compareCalibrationMetric, calibrationAgreement,
} from "../index.js"
import type { Metric } from "../index.js"
import { fixture, spanRecorder } from "./fixture.testing.js"

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
const calibration = Effect.runSync(defineGraderCalibration({ id: "calibration", version: "1", description: "Evidence boundary", input: Input, grader: target,
  cases: [true, false, null].map((value, index) => ({
    id: `case-${index}`, family: `family-${index}`, split: index === 2 ? "validation" as const : "calibration" as const,
    review: "known" as const, provenance: "Controlled evidence mutation", input: { evidence: Option.fromNullishOr(value) },
    reference: { status: value === null ? "unavailable" as const : "scored" as const,
      metrics: value === null ? [] : [{ metric: { kind: "boolean" as const, name: "valid", value }, tolerance: 0 }] },
  })),
}))
const app = defineEvaluationApp({ id: "calibration-test", suites: [], calibrations: [calibration.calibration],
  runnables: [calibration.runnable], graders: calibration.graders, projections: calibration.projections,
  environmentFor: { [calibration.runnable.definition.id]: calibration.environment.id }, fingerprints: {}, commands: {},
})
const store = Layer.succeed(EvaluationRunStore, { writeTrial: () => Effect.void, appendTranscript: () => Effect.void, writeRun: () => Effect.void })
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
test("a calibration is one eval.calibrate span over its run; the subject runs under each trial and the agreement is projected under each grade", async () => {
  const { tracer, named, parentOf } = spanRecorder()
  await Effect.runPromise(calibrateGrader(app, "calibration", "cal", { ids: [], split: "all" }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(app), store)), Effect.withTracer(tracer)))
  expect(named("eval.calibrate").map((span) => [span.attributes.get("eval.calibration.id"), span.attributes.get("eval.run.id")])).toEqual([["calibration", "cal"]])
  expect(named("eval.run").map(parentOf)).toEqual(["eval.calibrate"])
  expect(named("eval.calibration.execute").map(parentOf)).toEqual(["eval.trial", "eval.trial", "eval.trial"])
  expect(named("eval.calibration.project").map(parentOf)).toEqual(["eval.grade", "eval.grade", "eval.grade"])
  expect([...named("eval.calibration.execute"), ...named("eval.calibration.project")].every((span) => span.attributes.get("eval.calibration.id") === "calibration")).toBe(true)
})
test("a permissive mutation cannot pass calibration", async () => {
  const mutated = Effect.runSync(defineGraderCalibration({ id: "mutation", version: "1", description: "Always accepts", input: Input,
    grader: { ...target, layer: Layer.succeed(GraderAssessment, { assess: () => Effect.succeed({ status: "scored", metrics: [{ kind: "boolean", name: "valid", value: true }], reason: "Always accepts", usage: unknownEvaluationUsage, metadata: {} }) }) },
    cases: calibration.calibration.suite.tasks.map((task) => ({ ...task, split: task.split === "calibration" ? "calibration" as const : "validation" as const, input: Schema.decodeUnknownSync(Schema.toCodecJson(Input))(task.input), reference: Schema.decodeUnknownSync(CalibrationReference)(task.reference) })),
  }))
  const mutatedApp = { ...app, calibrations: [mutated.calibration], runnables: [mutated.runnable], graders: mutated.graders, projections: mutated.projections, environmentFor: { [mutated.runnable.definition.id]: mutated.environment.id } }
  const report = await Effect.runPromise(calibrateGrader(mutatedApp, "mutation", "mutation", { ids: [], split: "all" }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(mutatedApp), store))))
  expect(report.gates.filter((gate) => gate.passed)).toHaveLength(1)
  expect(report.gates.find((gate) => gate.metric === "false-pass")?.passed).toBe(false)
})

test("a case whose input does not encode is an invalid calibration, not a throw", async () => {
  const Positive = Schema.Struct({ count: Schema.Number.check(Schema.isGreaterThan(0)) })
  const exit = await Effect.runPromiseExit(defineGraderCalibration({ id: "unencodable", version: "1", description: "A bad case", input: Positive, grader: target,
    cases: [{ id: "negative", family: "negative", split: "calibration", review: "known", provenance: "A typo", input: { count: -1 }, reference: { status: "unavailable", metrics: [] } }],
  }))
  expect(exit._tag).toBe("Failure")
  expect(String(exit)).toContain("calibration unencodable, case negative: the input does not encode")
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
  await Promise.all(([
    [{ ...suite, tasks: [{ ...task, graders: [] }] }, "task-ungraded"],
    [{ ...suite, tasks: [{ ...task, graders: [task.graders[0]!, task.graders[0]!] }] }, "binding-duplicate"],
    [{ ...suite, tasks: [task, { ...task, id: EvalId.make("other"), split: "calibration" }] }, "split-mixed"],
  ] as const).map(async ([invalid, rule]) => {
    const refused = await Effect.runPromise(parseEvaluationApp({ ...base, suites: [invalid] }).pipe(Effect.flip))
    expect(refused.violations?.[0]?.rule).toBe(rule)
  }))
})

const yes = (name = "m"): Metric => ({ kind: "boolean", name, value: true })
const no: Metric = { kind: "boolean", name: "m", value: false }
const probability = (value: number): Metric => ({ kind: "probability", name: "m", value })
const score = (value: number, max = 5): Metric => ({ kind: "score", name: "m", value, min: 0, max })
const preference = (value: "A" | "B" | "tie"): Metric => ({ kind: "preference", name: "m", value })
const outcome = (actual: Metric, expected: Metric, tolerance: number) => Option.map(compareMetric(actual, expected, tolerance),
  ({ agreement, falsePass, falseFail, brier, absoluteError }) => ({ agreement, falsePass, falseFail, brier: Option.getOrNull(brier), absoluteError: Option.getOrNull(absoluteError) }))
const plain = (agreement: boolean, absoluteError: number | null = null) => Option.some({ agreement, falsePass: false, falseFail: false, brier: null, absoluteError })
test("compareMetric: booleans and preferences agree when equal; a boolean pass or fail against the other label is false", () => {
  expect(outcome(yes(), yes(), 0)).toEqual(plain(true))
  expect(outcome(no, no, 0)).toEqual(plain(true))
  expect(outcome(yes(), no, 1)).toEqual(Option.some({ agreement: false, falsePass: true, falseFail: false, brier: null, absoluteError: null }))
  expect(outcome(no, yes(), 1)).toEqual(Option.some({ agreement: false, falsePass: false, falseFail: true, brier: null, absoluteError: null }))
  expect(outcome(preference("A"), preference("A"), 0)).toEqual(plain(true))
  expect(outcome(preference("tie"), preference("B"), 1)).toEqual(plain(false))
})
test("compareMetric: two probabilities agree within the tolerance", () => {
  expect(outcome(probability(0.3), probability(0.35), 0.1)).toEqual(plain(true))
  expect(outcome(probability(0.3), probability(0.5), 0.1)).toEqual(plain(false))
  expect(outcome(probability(0.3), probability(0.3), 0)).toEqual(plain(true))
})
test("compareMetric: a probability against a boolean label is a pass from 0.5, with its Brier score", () => {
  expect(outcome(probability(0.5), yes(), 0)).toEqual(Option.some({ agreement: true, falsePass: false, falseFail: false, brier: 0.25, absoluteError: null }))
  expect(outcome(probability(0.25), yes(), 1)).toEqual(Option.some({ agreement: false, falsePass: false, falseFail: true, brier: 0.5625, absoluteError: null }))
  expect(outcome(probability(0.75), no, 1)).toEqual(Option.some({ agreement: false, falsePass: true, falseFail: false, brier: 0.5625, absoluteError: null }))
  expect(outcome(probability(0), no, 0)).toEqual(Option.some({ agreement: true, falsePass: false, falseFail: false, brier: 0, absoluteError: null }))
})
test("compareMetric: two scores on the same scale agree within the tolerance, with their absolute error", () => {
  expect(outcome(score(3), score(3.5), 0.5)).toEqual(plain(true, 0.5))
  expect(outcome(score(3), score(4), 0.5)).toEqual(plain(false, 1))
  expect(outcome(score(3, 5), score(3, 10), 1)).toEqual(Option.none())
})
test("compareMetric: anything else cannot be compared", () => {
  const pairs: ReadonlyArray<readonly [Metric, Metric]> = [
    [yes(), probability(1)], [score(1, 1), yes()], [preference("A"), yes()], [probability(0.5), score(0.5, 1)],
    [yes(), preference("A")], [score(1), probability(1)], [yes("m"), yes("other")], [probability(0.9), yes("other")],
  ]
  expect(pairs.map(([actual, expected]) => Option.isNone(compareMetric(actual, expected, 1)))).toEqual(pairs.map(() => true))
})
test("a score of 3 against a label of 3.2 agrees at tolerance 0.5 through compareMetric and the calibration's agreement grade", () => {
  const [actual, expected] = [score(3), score(3.2)]
  expect(Option.map(compareMetric(actual, expected, 0.5), ({ agreement }) => agreement)).toEqual(Option.some(true))
  const grade = calibrationAgreement({ status: "scored", metrics: [actual], reason: "" }, { status: "scored", metrics: [{ metric: expected, tolerance: 0.5 }] }, ["m"])
  expect(grade.map(({ name, value }) => [name, value])).toEqual([["agreement", true], ["status-agreement", true], ["metric-agreement", true], ["false-pass", false], ["false-fail", false]])
  // `compareCalibrationMetric` has no tolerance: the same pair is measured, and disagrees by 0.2.
  const exact = compareCalibrationMetric(actual, expected)
  expect(exact.status === "measured" && [exact.agreement, Option.getOrThrow(exact.absoluteError)]).toEqual([false, expect.closeTo(0.2)])
})
test("the agreement grade compares a probability with a boolean label at 0.5, and a duplicate metric cannot hide a false pass", () => {
  const label = (value: boolean): CalibrationReference => ({ status: "scored", metrics: [{ metric: { kind: "boolean", name: "m", value }, tolerance: 0 }] })
  const observed = (...metrics: ReadonlyArray<Metric>): CalibrationObservation => ({ status: "scored", metrics, reason: "" })
  const values = (metrics: ReadonlyArray<Metric>) => metrics.map(({ value }) => value)
  expect(values(calibrationAgreement(observed(probability(0.8)), label(true), ["m"]))).toEqual([true, true, true, false, false])
  expect(values(calibrationAgreement(observed(probability(0.8)), label(false), ["m"]))).toEqual([false, true, false, true, false])
  expect(values(calibrationAgreement(observed(probability(0.2)), label(true), ["m"]))).toEqual([false, true, false, false, true])
  expect(values(calibrationAgreement(observed(no, yes()), label(false), ["m"]))).toEqual([false, true, false, true, false])
})

const Claim = Schema.Struct({ support: Schema.Number })
/** A model grader as a semantic judge is one: a probability that the claim is supported, never a boolean. */
const supportCalibration = (judged: (support: number) => number) => Effect.runSync(defineGraderCalibration({
  id: "support", version: "1", description: "A judge's probability against pass/fail labels", input: Claim,
  grader: {
    definition: { id: EvalId.make("support-judge"), version: "1", kind: "model", metrics: ["supported"], fingerprints: {} },
    layer: Layer.succeed(GraderAssessment, {
      assess: (context) => Schema.decodeUnknownEffect(Claim)(context.input).pipe(
        Effect.mapError((error) => new EvaluationError({ code: "invalid", message: error.message })),
        Effect.map(({ support }) => ({ status: "scored" as const, metrics: [{ kind: "probability" as const, name: "supported", value: judged(support) }],
          reason: "Judged", usage: unknownEvaluationUsage, metadata: {} })),
      ),
    }),
  },
  cases: [0.9, 0.2].map((support, index) => ({ id: `claim-${index}`, family: `claim-${index}`, split: "calibration" as const, review: "known" as const,
    provenance: "Controlled support", input: { support },
    reference: { status: "scored" as const, metrics: [{ metric: { kind: "boolean" as const, name: "supported", value: support > 0.5 }, tolerance: 0 }] } })),
}))
const calibrate = (judged: (support: number) => number) => {
  const support = supportCalibration(judged)
  const supportApp = { ...app, calibrations: [support.calibration], runnables: [support.runnable], graders: support.graders, projections: support.projections,
    environmentFor: { [support.runnable.definition.id]: support.environment.id } }
  return Effect.runPromise(calibrateGrader(supportApp, "support", "support", { ids: [], split: "all" }).pipe(Effect.provide(Layer.merge(EvaluationServicesLive(supportApp), store))))
}
test("a grader that answers with a probability is measured against boolean labels at 0.5", async () => {
  expect(supportCalibration((support) => support).graders[0]?.definition.fingerprints.comparison).toBe("calibration-agreement:2")
  const calibrated = await calibrate((support) => support)
  expect(calibrated.gates.map(({ metric, passed }) => [metric, passed])).toEqual([["agreement", true], ["false-pass", true], ["false-fail", true]])
  const credulous = await calibrate(() => 0.7)
  expect(credulous.gates.map(({ metric, passed, value }) => [metric, passed, Option.getOrNull(value)])).toEqual([["agreement", false, 0.5], ["false-pass", false, 0.5], ["false-fail", true, 0]])
})
