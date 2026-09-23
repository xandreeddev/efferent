import { expect, test } from "bun:test"
import { Effect, Layer, Option, Ref, Schema } from "effect"
import { AssessmentError, EvaluationTrial } from "./assessment.entity.js"
import { assessAll, runBenchmark, bindBenchmark, runEvaluationCampaign } from "./assessment.usecase.functions.js"
import { validateDataset, evaluateGates, summarizeAssessments } from "./assessment.entity.functions.js"
import { compareCalibrationMetric } from "./evaluator-calibration.entity.functions.js"
import { assessBothOrders } from "./evaluators/pairwise.js"
import { EvaluationStore } from "./ports/assessment.port.js"
import type { Benchmark, Dataset, Evaluator } from "./assessment.usecase.js"

const data: Dataset<string, boolean> = {
  id: "examples", version: "1", input: Schema.String, reference: Schema.Boolean,
  cases: [
    { id: "good", family: "good", split: "calibration", review: "known", input: "supported", reference: true, provenance: "controlled fixture" },
    { id: "bad", family: "bad", split: "validation", review: "known", input: "fabricated", reference: false, provenance: "controlled fixture" },
  ],
}
const judge: Evaluator<{ readonly output: string; readonly reference: boolean }> = {
  id: "quality", version: "1", metrics: ["supported", "helpful"],
  run: (input) => Effect.succeed({ metrics: [{ kind: "boolean", name: "supported", value: input.output === "supported" }, { kind: "score", name: "helpful", value: 1, min: 0, max: 1 }], reason: "fixture" }),
}
const benchmark: Benchmark<string, string, string, boolean> = {
  id: "answer", kind: "benchmark", dataset: data, output: Schema.String, evidence: Schema.String,
  task: (input) => Effect.succeed({ output: input, evidence: input }),
  evaluators: [{ evaluator: judge, select: ["supported", "helpful"] }],
}
const options = { runId: "test", split: "validation" as const, candidate: { id: "scripted" }, repetitions: 1 }
const memory = Layer.succeed(EvaluationStore, { writeTrial: () => Effect.void, writeAssessment: () => Effect.void })

test("dataset rejects duplicate IDs and cross-split case families", async () => {
  expect(await Effect.runPromise(validateDataset(data).pipe(Effect.isSuccess))).toBe(true)
  expect(await Effect.runPromise(validateDataset({ ...data, cases: data.cases.map((c) => ({ ...c, family: "shared" })) }).pipe(Effect.isSuccess))).toBe(false)
  expect(await Effect.runPromise(validateDataset({ ...data, cases: [...data.cases, data.cases[0]!] }).pipe(Effect.isSuccess))).toBe(false)
})
test("one judge call emits several independently selected metrics", async () => {
  const program = Effect.gen(function* () {
    const count = yield* Ref.make(0)
    const bound = { ...judge, run: (input: { output: string; reference: boolean }) => Ref.update(count, (n) => n + 1).pipe(Effect.zipRight(judge.run(input))) }
    const result = yield* assessAll([{ evaluator: bound, select: ["supported"] }], { output: "supported", reference: true })
    expect(yield* Ref.get(count)).toBe(1)
    expect(result[0]?.metrics.map((m) => m.name)).toEqual(["supported"])
    expect(yield* assessAll([{ evaluator: bound, select: ["supported"] }, { evaluator: bound, select: ["helpful"] }], { output: "", reference: false }).pipe(Effect.isFailure)).toBe(true)
  })
  await Effect.runPromise(program)
})
test("provider failure is unavailable, never a measured zero", async () => {
  const result = await Effect.runPromise(assessAll([{ evaluator: { ...judge, run: () => Effect.fail(new AssessmentError({ code: "unavailable", message: "missing evidence" })) }, select: ["supported"] }], { output: "", reference: false }))
  expect(result[0]?.status).toBe("unavailable")
  expect(result[0]?.metrics).toEqual([])
  expect(Option.isNone(result[0]!.usage.costUsd)).toBe(true)
  expect(summarizeAssessments(result).scored).toBe(0)
})
test("invalid judge output is an execution error, not clamped", async () => {
  const result = await Effect.runPromise(assessAll([{ evaluator: { ...judge, metrics: ["helpful"], run: () => Effect.succeed({ metrics: [{ kind: "score", name: "helpful", value: 7, min: 0, max: 1 }], reason: "invalid" }) }, select: ["helpful"] }], { output: "", reference: false }))
  expect(result[0]?.status).toBe("error")
  expect(result[0]?.metrics).toEqual([])
})
test("task evidence persists before judging and final artifacts round-trip", async () => {
  const writes: string[] = []
  const store = Layer.succeed(EvaluationStore, { writeTrial: (trial) => Effect.sync(() => { writes.push(`trial:${trial.evaluations.length}`) }), writeAssessment: () => Effect.sync(() => { writes.push("assessment") }) })
  const [trial] = await Effect.runPromise(runBenchmark(benchmark, options).pipe(Effect.provide(store)))
  expect(writes).toEqual(["trial:0", "assessment", "trial:1"])
  expect(trial?.status).toBe("completed")
  const encoded = Schema.encodeSync(EvaluationTrial)(trial!)
  expect(Schema.decodeUnknownSync(EvaluationTrial)(encoded)).toEqual(trial!)
  expect(evaluateGates(trial!, [{ evaluator: "quality", metric: "supported", minimum: 1, mode: "blocking" }]).passed).toBe(false)
  expect(evaluateGates(trial!, [{ evaluator: "quality", metric: "supported", minimum: 1, mode: "diagnostic" }]).passed).toBe(true)
})
test("task failure preserves a failed trial without judging", async () => {
  const [trial] = await Effect.runPromise(runBenchmark({ ...benchmark, task: () => Effect.fail(new AssessmentError({ code: "provider", message: "offline" })) }, options).pipe(Effect.provide(memory)))
  expect(trial?.status).toBe("error")
  expect(trial?.evaluations).toEqual([])
  expect(Option.isNone(trial!.output)).toBe(true)
})
test("export failure preserves completed local trials", async () => {
  const campaign = await Effect.runPromise(runEvaluationCampaign({ targets: [bindBenchmark(benchmark)], candidates: [{ id: "scripted" }], execution: options, reporters: [{ id: "broken", write: () => Effect.fail(new AssessmentError({ code: "persistence", message: "offline" })) }] }).pipe(Effect.provide(memory)))
  expect(campaign.trials).toHaveLength(1)
  expect(campaign.reporters[0]?.status).toBe("error")
})
test("calibration distinguishes probabilities from scalar scores", () => {
  const result = compareCalibrationMetric({ kind: "probability", name: "grounded", value: 0.8 }, { kind: "boolean", name: "grounded", value: true })
  expect(result.status).toBe("measured")
  if (result.status === "measured") expect(Option.getOrThrow(result.brier)).toBeCloseTo(0.04)
  expect(compareCalibrationMetric({ kind: "score", name: "grounded", value: 0.8, min: 0, max: 1 }, { kind: "boolean", name: "grounded", value: true }).status).toBe("unavailable")
})
test("pairwise positional preference is flagged, never reported as a tie", async () => {
  const result = await Effect.runPromise(assessBothOrders("left", "right", () => Effect.succeed("A")))
  expect(result).toEqual({ forward: "A", reverse: "A", consistent: false })
})

test("cancellation during judging persists a terminal trial and evidence", async () => {
  const { Deferred, Fiber } = await import("effect")
  const program = Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const saved = yield* Ref.make<ReadonlyArray<typeof EvaluationTrial.Type>>([])
    const store = Layer.succeed(EvaluationStore, {
      writeTrial: (trial) => Ref.update(saved, (prior) => [...prior, trial]), writeAssessment: () => Effect.void,
    })
    const blocking = { ...benchmark, evaluators: [{ evaluator: { ...judge, run: () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)) }, select: ["supported"] }] }
    const fiber = yield* runBenchmark(blocking, options).pipe(Effect.provide(store), Effect.fork)
    yield* Deferred.await(entered)
    yield* Fiber.interrupt(fiber)
    const trials = yield* Ref.get(saved)
    expect(trials.at(-1)?.status).toBe("cancelled")
    expect(Option.getOrThrow(trials.at(-1)!.evidence)).toBe("fabricated")
  })
  await Effect.runPromise(program)
})

test("comparison rejects missing assessments and mismatched metric coverage", async () => {
  const { comparisonIssues, evaluationFingerprint } = await import("./assessment-report.functions.js")
  const trials = await Effect.runPromise(runBenchmark(benchmark, options).pipe(Effect.provide(memory)))
  const identity = { datasetHash: "d", fixtureHash: "f", evaluatorHash: "e", policyVersion: "p", evidenceVersion: "v" }
  const report = { identity, trials }
  expect(evaluationFingerprint({ a: 1, b: 2 })).toBe(evaluationFingerprint({ b: 2, a: 1 }))
  expect(comparisonIssues(report, report)).toEqual([])
  expect(comparisonIssues(report, { identity, trials: trials.map((trial) => ({ ...trial, evaluations: [] })) })).not.toEqual([])
  expect(comparisonIssues(report, { identity, trials: trials.map((trial) => ({ ...trial, evaluations: trial.evaluations.map((result) => ({ ...result, metrics: result.metrics.slice(0, 1) })) })) })).not.toEqual([])
  expect(evaluateGates({ ...trials[0]!, review: "provisional" }, [{ evaluator: "quality", metric: "helpful", minimum: 1, mode: "blocking", requiresReviewedReference: true }]).passed).toBe(false)
})

test("calibration coverage excludes missing predictions and preserves confusion counts", async () => {
  const { summarizeCalibration } = await import("./evaluator-calibration.entity.functions.js")
  const result = summarizeCalibration([
    { actual: Option.some({ kind: "probability", name: "grounded", value: 0.9 }), reference: { kind: "boolean", name: "grounded", value: false } },
    { actual: Option.none(), reference: { kind: "boolean", name: "grounded", value: true } },
  ])
  expect(result.measured).toBe(1)
  expect(result.unavailable).toBe(1)
  expect(result.confusion.falsePositive).toBe(1)
  expect(Option.getOrThrow(result.brier)).toBeCloseTo(0.81)
  expect(Option.isNone(result.recall)).toBe(true)
  expect(result.reliability[9]?.count).toBe(1)
})

test("journey records partial observations and releases its world on a failed step", async () => {
  const { journeyTask } = await import("./journey-assessment.usecase.functions.js")
  const recorded: string[] = []
  const task = journeyTask({
    boot: (_: string) => Effect.acquireRelease(Effect.succeed("world"), () => Effect.sync(() => { recorded.push("released") })),
    steps: (_: string) => [{ id: "first", act: () => Effect.succeed("observation") }, { id: "second", act: () => Effect.fail(new AssessmentError({ code: "provider", message: "failed" })) }],
    record: (id: string, _observation: string) => Effect.sync(() => { recorded.push(id) }),
    evidence: (_world: string, observations: ReadonlyArray<string>) => Effect.succeed(observations),
  })
  const result = await Effect.runPromise(Effect.scoped(task("input")))
  expect(result.output.completed).toBe(false)
  expect(result.evidence).toEqual(["observation"])
  expect(recorded).toEqual(["first", "released"])
})
