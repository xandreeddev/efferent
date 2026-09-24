import { Cause, Clock, Effect, Exit, Option, Ref, Schema } from "effect"
import { AssessmentError, EvaluationId, type EvaluationResult, type EvaluationTrial } from "./assessment.entity.js"
import { validateDataset, validateMetrics } from "./assessment.entity.functions.js"
import type { Benchmark, BenchmarkOptions, BoundEvaluation, EvaluatorBinding, EvaluationReporter } from "./assessment.usecase.js"
import { EvaluationStore } from "./ports/assessment.port.js"

export const unknownEvaluationUsage = { inputTokens: Option.none<number>(), outputTokens: Option.none<number>(), costUsd: Option.none<number>() }

export const assess = <I, R>(binding: EvaluatorBinding<I, R>, input: I): Effect.Effect<EvaluationResult, never, R> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const evaluator = binding.evaluator
    const result = yield* evaluator.run(input).pipe(
      Effect.tap((value) => validateMetrics(value.metrics, evaluator.metrics)),
      Effect.timeoutFail({ duration: binding.timeoutMs ?? 90_000, onTimeout: () => new AssessmentError({ code: "timeout", message: "Evaluator exceeded its deadline" }) }),
      Effect.exit,
    )
    const common = { version: 2 as const, evaluator: evaluator.id, evaluatorVersion: evaluator.version, startedAt, endedAt: yield* Clock.currentTimeMillis }
    if (Exit.isFailure(result)) {
      const error = Cause.failureOption(result.cause)
      return { ...common, status: Option.isSome(error) && error.value.code === "unavailable" ? "unavailable" as const : "error" as const, metrics: [], references: [], reason: Option.some(Cause.pretty(result.cause)), usage: unknownEvaluationUsage, metadata: {} }
    }
    return { ...common, status: "scored" as const, metrics: result.value.metrics.filter((metric) => binding.select.includes(metric.name)), reason: Option.some(result.value.reason), references: result.value.references ?? [], usage: result.value.usage ?? unknownEvaluationUsage, metadata: result.value.metadata ?? {} }
  }).pipe(Effect.withSpan("eval.evaluator", { attributes: { "eval.evaluator.id": binding.evaluator.id, "eval.evaluator.version": binding.evaluator.version } }))

export const validateBindings = <I, R>(bindings: ReadonlyArray<EvaluatorBinding<I, R>>) => {
  const ids = bindings.map((binding) => binding.evaluator.id)
  return new Set(ids).size !== ids.length || bindings.some(({ evaluator, select, timeoutMs }) => (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) || !evaluator.id.trim() || !evaluator.version.trim() || select.length === 0 || new Set(select).size !== select.length || new Set(evaluator.metrics).size !== evaluator.metrics.length || select.some((name) => !evaluator.metrics.includes(name)))
    ? Effect.fail(new AssessmentError({ code: "invalid", message: "Evaluator bindings require unique IDs and valid metric selections" }))
    : Effect.void
}

/** Also used to rescore saved evidence; no task execution or export is involved. */
export const assessAll = <I, R>(bindings: ReadonlyArray<EvaluatorBinding<I, R>>, input: I) =>
  validateBindings(bindings).pipe(Effect.zipRight(Effect.forEach(bindings, (binding) => assess(binding, input))))

export const runBenchmark = <I, O, E, Ref, R>(benchmark: Benchmark<I, O, E, Ref, R>, options: BenchmarkOptions) => Effect.gen(function* () {
  yield* validateDataset(benchmark.dataset)
  yield* validateBindings(benchmark.evaluators)
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1 || (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1)) || (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)))
    return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Invalid repetition, concurrency or deadline configuration" }))
  const store = yield* EvaluationStore
  const cases = benchmark.dataset.cases.filter((entry) => entry.split === options.split)
  const cells = cases.flatMap((entry) => Array.from({ length: options.repetitions }, (_, index) => ({ entry, sample: index + 1 })))
  return yield* Effect.forEach(cells, ({ entry, sample }) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const id = EvaluationId.make(`${options.runId}/${benchmark.id}/${entry.id}/${sample}`)
    const execution = yield* restore(Effect.scoped(benchmark.task(entry.input).pipe(
      Effect.tap(({ output, evidence }) => Effect.all([Schema.validate(benchmark.output)(output), Schema.validate(benchmark.evidence)(evidence)])),
      Effect.timeoutFail({ duration: options.timeoutMs ?? 90_000, onTimeout: () => new AssessmentError({ code: "timeout", message: "Task execution exceeded its deadline" }) }),
    ))).pipe(Effect.exit)
    const trial: EvaluationTrial = {
      version: 2, id, target: benchmark.id, kind: benchmark.kind, dataset: benchmark.dataset.id, datasetVersion: benchmark.dataset.version,
      caseId: entry.id, split: entry.split, review: entry.review, candidate: options.candidate, sample,
      startedAt, endedAt: yield* Clock.currentTimeMillis,
      status: Exit.isSuccess(execution) ? "completed" : Cause.isInterruptedOnly(execution.cause) ? "cancelled" : "error",
      output: Exit.isSuccess(execution) ? Option.some(execution.value.output) : Option.none(),
      evidence: Exit.isSuccess(execution) ? Option.some(execution.value.evidence) : Option.none(),
      reason: Exit.isSuccess(execution) ? Option.none() : Option.some(Cause.pretty(execution.cause)), evaluations: [],
    }
    yield* store.writeTrial(trial)
    if (Exit.isFailure(execution)) return trial
    const input = { input: entry.input, output: execution.value.output, evidence: execution.value.evidence, reference: entry.reference }
    const recorded = yield* Ref.make<ReadonlyArray<EvaluationResult>>([])
    const assessmentExit = yield* restore(Effect.forEach(benchmark.evaluators, (binding) => assess(binding, input).pipe(
      Effect.flatMap((result) => Effect.uninterruptible(store.writeAssessment(id, result).pipe(
        Effect.zipRight(Ref.update(recorded, (prior) => [...prior, result])),
      ))),
    ))).pipe(Effect.exit)
    const evaluations = yield* Ref.get(recorded)
    if (Exit.isFailure(assessmentExit)) {
      yield* store.writeTrial({ ...trial, evaluations, status: Cause.isInterruptedOnly(assessmentExit.cause) ? "cancelled" : "error", reason: Option.some(Cause.pretty(assessmentExit.cause)), endedAt: yield* Clock.currentTimeMillis })
      return yield* Effect.failCause(assessmentExit.cause)
    }
    const settled = { ...trial, evaluations, endedAt: yield* Clock.currentTimeMillis }
    yield* store.writeTrial(settled)
    return settled
  })).pipe(Effect.withSpan("eval.trial", { attributes: { "eval.target": benchmark.id, "eval.case": entry.id, "eval.sample": sample } })), { concurrency: options.concurrency ?? 1 })
})

export const bindBenchmark = <I, O, E, Ref, R>(benchmark: Benchmark<I, O, E, Ref, R>): BoundEvaluation<R | EvaluationStore> => ({
  id: benchmark.id, kind: benchmark.kind, run: (options) => runBenchmark(benchmark, options),
})

export const runEvaluationCampaign = <R>(options: {
  readonly targets: ReadonlyArray<BoundEvaluation<R>>
  readonly candidates: ReadonlyArray<Readonly<Record<string, unknown>>>
  readonly execution: Omit<BenchmarkOptions, "candidate">
  readonly reporters?: ReadonlyArray<EvaluationReporter<R>>
}) => Effect.gen(function* () {
  const ids = options.targets.map((target) => target.id)
  if (ids.length === 0 || options.candidates.length === 0 || new Set(ids).size !== ids.length)
    return yield* Effect.fail(new AssessmentError({ code: "invalid", message: "Campaign needs unique targets and at least one candidate" }))
  const batches = yield* Effect.forEach(options.candidates, (candidate, index) => Effect.forEach(options.targets, (target) => target.run({ ...options.execution, candidate, runId: `${options.execution.runId}/${index}` }).pipe(Effect.exit, Effect.map((result) => ({ target: target.id, candidate, result })))))
  const trials = batches.flat().flatMap(({ result }) => Exit.isSuccess(result) ? result.value : [])
  const failures = batches.flat().flatMap(({ target, candidate, result }) => Exit.isFailure(result) ? [{ target, candidate, reason: Cause.pretty(result.cause) }] : [])
  const reporters = yield* Effect.forEach(options.reporters ?? [], (reporter) => reporter.write(trials).pipe(
    Effect.match({ onFailure: (error) => ({ id: reporter.id, status: "error" as const, reason: Option.some(error.message) }), onSuccess: () => ({ id: reporter.id, status: "complete" as const, reason: Option.none<string>() }) }),
  ))
  return { version: 2 as const, trials, failures, reporters }
}).pipe(Effect.withSpan("eval.campaign"))
