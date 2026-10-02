import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect"
import { AssessmentError, EvaluationTrial } from "./assessment.entity.js"
import { comparisonIssues, evaluationFingerprint } from "./assessment-report.functions.js"
import type { Dataset, Evaluator } from "./assessment.usecase.js"
import { calibrationIdentity, calibrationMarkdown } from "./calibration.entity.functions.js"
import { CalibrationReport } from "./calibration.entity.js"
import type { Calibration } from "./calibration.usecase.js"
import { decodeCandidates, defineCalibration, runCalibration, validateCalibration } from "./calibration.usecase.functions.js"
import { EvaluationStore } from "./ports/assessment.port.js"
import { SemanticJudge } from "./ports/semantic-judge.port.js"

const Candidate = Schema.Struct({ id: Schema.String, flavour: Schema.Literals(["plain", "spicy"]) })
type Candidate = typeof Candidate.Type
const dataset: Dataset<string, boolean> = {
  id: "answers", version: "1", input: Schema.String, reference: Schema.Boolean,
  cases: [
    { id: "good", family: "good", split: "calibration", review: "known", input: "supported", reference: true, provenance: "controlled fixture" },
    { id: "bad", family: "bad", split: "calibration", review: "known", input: "fabricated", reference: false, provenance: "controlled fixture" },
    { id: "held-out", family: "held-out", split: "validation", review: "known", input: "supported", reference: true, provenance: "controlled fixture" },
  ],
}
/** The judge under test is also the scored metric: `supported` says what the subject answered, `agreement` compares it with the label. */
const contract: Evaluator<{ readonly output: string; readonly reference: boolean }> = {
  id: "answer.contract", version: "1", metrics: ["supported", "agreement"],
  run: (input) => Effect.succeed({ metrics: [{ kind: "boolean", name: "supported", value: input.output === "supported" }, { kind: "boolean", name: "agreement", value: (input.output === "supported") === input.reference }], reason: "fixture" }),
}
/** Each build hands out a new judge whose id is its build number, so shared instances show up as repeated ids. */
const countedJudges = (built: Ref.Ref<number>) => Layer.effect(SemanticJudge, Ref.updateAndGet(built, (n) => n + 1).pipe(
  Effect.map((n) => SemanticJudge.of({ id: `judge-${n}`, evaluate: () => Effect.fail(new AssessmentError({ code: "unavailable", message: "unused" })) })),
))
const definition = (built: Ref.Ref<number>, candidates: ReadonlyArray<Candidate> = [{ id: "a", flavour: "plain" }]): Calibration<string, string, string, boolean, Candidate, SemanticJudge, never> => defineCalibration({
  id: "answer", version: "1", dataset, candidate: Candidate, candidates,
  subject: {
    task: (input) => SemanticJudge.pipe(Effect.map((judge) => ({ output: input, evidence: judge.id }))),
    services: () => countedJudges(built),
    fingerprints: { prompt: "answer-v1" },
  },
  output: Schema.String, evidence: Schema.String,
  evaluators: [{ evaluator: contract, select: ["supported", "agreement"] }],
  gates: [
    { evaluator: "answer.contract", metric: "agreement", aggregate: "passRate", minimum: 1, mode: "blocking" },
    { evaluator: "answer.contract", metric: "supported", aggregate: "mean", maximum: 0.4, mode: "diagnostic" },
  ],
  select: (summaries) => summaries.filter((summary) => summary.passed).toSorted((left, right) => left.performance.attempts - right.performance.attempts),
  run: { repetitions: 1, concurrency: 1, timeoutMs: 1_000 },
})
const memory = Layer.succeed(EvaluationStore, { writeTrial: () => Effect.void, writeAssessment: () => Effect.void })
const run = { runId: "test", split: "calibration" as const }

test("every case runs on fresh services and the task never sees the reference", async () => {
  const built = await Effect.runPromise(Ref.make(0))
  const report = await Effect.runPromise(runCalibration(definition(built), { ...run, repetitions: 2 }).pipe(Effect.provide(memory)))
  expect(report.trials).toHaveLength(4)
  expect(new Set(report.trials.flatMap((trial) => Option.toArray(trial.evidence)))).toHaveProperty("size", 4)
  expect(report.trials.map((trial) => trial.output)).toEqual(report.trials.map((trial) => Option.some(dataset.cases.find((entry) => entry.id === trial.caseId)!.input)))
  expect(Schema.decodeUnknownSync(CalibrationReport)(Schema.encodeSync(CalibrationReport)(report))).toEqual(report)
})
test("aggregate gates report their value; only blocking ones decide and the host selects", async () => {
  const built = await Effect.runPromise(Ref.make(0))
  const report = await Effect.runPromise(runCalibration(definition(built), run).pipe(Effect.provide(memory)))
  const [candidate] = report.candidates
  expect(candidate?.gates.map((gate) => [gate.metric, gate.passed, Option.getOrThrow(gate.value)])).toEqual([["agreement", true, 1], ["supported", false, 0.5]])
  expect(candidate?.passed).toBe(true)
  expect(candidate?.metrics["answer.contract/supported"]?.count).toBe(2)
  expect(report.recommendation).toEqual(Option.some("a"))
  expect(report.promotionEligible).toBe(true)
  expect(calibrationMarkdown(report)).toContain("Recommendation: a (promotion eligible)")
})
test("a failing blocking gate, a provisional label or a candidate failure blocks promotion", async () => {
  const built = await Effect.runPromise(Ref.make(0))
  const strict = { ...definition(built), gates: [{ evaluator: "answer.contract", metric: "supported", aggregate: "mean" as const, minimum: 0.9, mode: "blocking" as const }] }
  const failed = await Effect.runPromise(runCalibration(strict, run).pipe(Effect.provide(memory)))
  expect(failed.candidates[0]?.passed).toBe(false)
  expect(failed.candidates[0]?.gates[0]?.findings[0]).toContain("below 0.9")
  expect(failed.recommendation).toEqual(Option.none())
  const provisional = { ...definition(built), dataset: { ...dataset, cases: dataset.cases.map((entry) => entry.id === "bad" ? { ...entry, review: "provisional" as const } : entry) } }
  const unreviewed = await Effect.runPromise(runCalibration(provisional, run).pipe(Effect.provide(memory)))
  expect(unreviewed.reviewed).toBe(false)
  expect(unreviewed.recommendation).toEqual(Option.some("a"))
  expect(unreviewed.promotionEligible).toBe(false)
  const broken = Layer.succeed(EvaluationStore, { writeTrial: (trial) => trial.candidate.id === "b" ? Effect.fail(new AssessmentError({ code: "persistence", message: "disk full" })) : Effect.void, writeAssessment: () => Effect.void })
  const partial = await Effect.runPromise(runCalibration(definition(built, [{ id: "a", flavour: "plain" }, { id: "b", flavour: "spicy" }]), run).pipe(Effect.provide(broken)))
  expect(partial.failures.map((failure) => failure.candidate)).toEqual(["b"])
  expect(partial.candidates.map((candidate) => candidate.passed)).toEqual([true, false])
  expect(partial.promotionEligible).toBe(false)
})
test("no selection policy means no recommendation; without it the library never ranks", async () => {
  const built = await Effect.runPromise(Ref.make(0))
  const { select: _select, ...unranked } = definition(built)
  const report = await Effect.runPromise(runCalibration(unranked, run).pipe(Effect.provide(memory)))
  expect(report.recommendation).toEqual(Option.none())
  expect(report.promotionEligible).toBe(false)
})
test("judge calibration pairs the subject's metrics with reference labels", async () => {
  const built = await Effect.runPromise(Ref.make(0))
  const judged = { ...definition(built), judgeCalibration: {
    reference: (reference: boolean) => [{ kind: "boolean" as const, name: "supported", value: reference }],
    actual: (output: string) => [{ kind: "probability" as const, name: "supported", value: output === "supported" ? 0.9 : 0.1 }],
  } }
  const report = await Effect.runPromise(runCalibration(judged, run).pipe(Effect.provide(memory)))
  const summary = Option.getOrThrow(report.candidates[0]!.calibration)
  expect(summary.measured).toBe(2)
  expect(summary.confusion).toEqual({ truePositive: 1, trueNegative: 1, falsePositive: 0, falseNegative: 0 })
  expect(Option.getOrThrow(summary.agreement)).toBe(1)
})
test("identity is stable under key order and follows the subject fingerprint", async () => {
  const built = await Effect.runPromise(Ref.make(0))
  const base = definition(built)
  expect(evaluationFingerprint({ a: 1, b: 2 })).toBe(evaluationFingerprint({ b: 2, a: 1 }))
  expect(calibrationIdentity(base)).toEqual(calibrationIdentity(definition(built)))
  expect(calibrationIdentity({ ...base, subject: { ...base.subject, fingerprints: { prompt: "answer-v2" } } }).subjectHash).not.toBe(calibrationIdentity(base).subjectHash)
  const report = await Effect.runPromise(runCalibration(base, run).pipe(Effect.provide(memory)))
  expect(comparisonIssues(report, report)).toEqual([])
  expect(comparisonIssues(report, { ...report, trials: report.trials.map((trial) => ({ ...trial, evaluations: [] })) })).not.toEqual([])
  expect(comparisonIssues(report, { ...report, identity: { ...report.identity, subjectHash: "other" } })[0]).toContain("fingerprint mismatch")
})
test("definitions and candidate files are checked before anything runs", async () => {
  const built = await Effect.runPromise(Ref.make(0))
  const base = definition(built)
  expect(await Effect.runPromise(validateCalibration(base).pipe(Effect.isSuccess))).toBe(true)
  expect(await Effect.runPromise(validateCalibration({ ...base, gates: [{ evaluator: "answer.contract", metric: "missing", aggregate: "mean", mode: "blocking" }] }).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(validateCalibration({ ...base, candidates: [{ id: "a", flavour: "plain" }, { id: "a", flavour: "spicy" }] }).pipe(Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(runCalibration(base, { ...run, repetitions: 0 }).pipe(Effect.provide(memory), Effect.isFailure))).toBe(true)
  expect(await Effect.runPromise(decodeCandidates(base, JSON.stringify([{ id: "a", flavour: "plain" }])))).toEqual([{ id: "a", flavour: "plain" }])
  expect(await Effect.runPromise(decodeCandidates(base, JSON.stringify([{ id: "a", flavour: "plain", temprature: 0 }])).pipe(Effect.isFailure))).toBe(true)
})
test("a task failure is a failed trial without judging; cancellation during judging persists a terminal trial", async () => {
  const built = await Effect.runPromise(Ref.make(0))
  const base = definition(built)
  const offline = { ...base, subject: { ...base.subject, task: () => Effect.fail(new AssessmentError({ code: "provider", message: "offline" })) } }
  const failed = await Effect.runPromise(runCalibration(offline, run).pipe(Effect.provide(memory)))
  expect(failed.trials.map((trial) => trial.status)).toEqual(["error", "error"])
  expect(failed.trials.every((trial) => trial.evaluations.length === 0 && Option.isNone(trial.output))).toBe(true)
  expect(failed.candidates[0]?.performance).toMatchObject({ attempts: 2, completed: 0, failed: 2 })
  const program = Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const saved = yield* Ref.make<ReadonlyArray<typeof EvaluationTrial.Type>>([])
    const store = Layer.succeed(EvaluationStore, { writeTrial: (trial) => Ref.update(saved, (prior) => [...prior, trial]), writeAssessment: () => Effect.void })
    const blocking = { ...base, evaluators: [{ evaluator: { ...contract, run: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)) }, select: ["supported", "agreement"] }] }
    const fiber = yield* runCalibration(blocking, run).pipe(Effect.provide(store), Effect.forkChild)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(fiber)
    const trials = yield* Ref.get(saved)
    expect(trials.at(-1)?.status).toBe("cancelled")
    expect(Option.getOrThrow(trials.at(-1)!.output)).toBe("supported")
  })
  await Effect.runPromise(program)
})
