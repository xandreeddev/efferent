import { Cause, Clock, Effect, Exit, Option, Ref, Schema } from "effect"
import { isolatedServices } from "./adapters/isolated-services.adapter.js"
import { AssessmentError, EvaluationId, type EvaluationResult, type EvaluationTrial } from "./assessment.entity.js"
import { validateDataset } from "./assessment.entity.functions.js"
import type { DatasetCase } from "./assessment.usecase.js"
import { assess, validateBindings } from "./assessment.usecase.functions.js"
import { calibrationIdentity, candidateReport } from "./calibration.entity.functions.js"
import type { CalibrationReport, CalibrationRunSettings } from "./calibration.entity.js"
import type { Calibration, CalibrationRun, CandidateSummary } from "./calibration.usecase.js"
import { EvaluationStore } from "./ports/assessment.port.js"

const invalid = (message: string) => new AssessmentError({ code: "invalid", message })
const CandidateRecord = Schema.Record(Schema.String, Schema.Unknown)

/** Keeps the definition's inferred types; `validateCalibration` checks it, `runCalibration` runs it. */
export const defineCalibration = <I, O, E, Ref, C extends { readonly id: string }, R, Shared>(definition: Calibration<I, O, E, Ref, C, R, Shared>): Calibration<I, O, E, Ref, C, R, Shared> => definition

const validRun = (run: { readonly repetitions: number; readonly concurrency: number; readonly timeoutMs: number }): boolean =>
  Number.isInteger(run.repetitions) && run.repetitions >= 1 && Number.isInteger(run.concurrency) && run.concurrency >= 1 && Number.isFinite(run.timeoutMs) && run.timeoutMs > 0

export const validateCalibration = <I, O, E, Ref, C extends { readonly id: string }, R, Shared>(definition: Calibration<I, O, E, Ref, C, R, Shared>) => Effect.gen(function* () {
  if (!definition.id.trim() || !definition.version.trim()) return yield* Effect.fail(invalid("Calibration needs an id and a version"))
  yield* validateDataset(definition.dataset)
  yield* validateBindings(definition.evaluators)
  const ids = definition.candidates.map((candidate) => candidate.id)
  if (ids.length === 0 || new Set(ids).size !== ids.length || ids.some((id) => !id.trim())) return yield* Effect.fail(invalid("Calibration needs candidates with unique, nonempty ids"))
  const unbound = definition.gates.filter((gate) => !definition.evaluators.some((binding) => binding.evaluator.id === gate.evaluator && binding.select.includes(gate.metric)))
  if (unbound.length > 0 || definition.gates.some((gate) => gate.minimum !== undefined && gate.maximum !== undefined && gate.minimum > gate.maximum))
    return yield* Effect.fail(invalid("Gates must name a bound evaluator metric with minimum <= maximum"))
  if (!validRun(definition.run)) return yield* Effect.fail(invalid("Invalid repetition, concurrency or deadline configuration"))
  return definition
})

const settingsOf = <I, O, E, Ref, C extends { readonly id: string }, R, Shared>(definition: Calibration<I, O, E, Ref, C, R, Shared>, run: CalibrationRun): Effect.Effect<CalibrationRunSettings, AssessmentError> => {
  const settings: CalibrationRunSettings = {
    runId: run.runId,
    split: run.split,
    repetitions: run.repetitions ?? definition.run.repetitions,
    concurrency: run.concurrency ?? definition.run.concurrency,
    timeoutMs: run.timeoutMs ?? definition.run.timeoutMs,
  }
  return settings.runId.trim() && validRun(settings) ? Effect.succeed(settings) : Effect.fail(invalid("Invalid run id, repetition, concurrency or deadline configuration"))
}

/** Candidates from a JSON array: unknown fields are errors, never dropped. */
export const decodeCandidates = <I, O, E, Ref, C extends { readonly id: string }, R, Shared>(definition: Calibration<I, O, E, Ref, C, R, Shared>, text: string): Effect.Effect<ReadonlyArray<C>, AssessmentError> =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(definition.candidate)))(text, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) => invalid(String(error))),
  )

const encodeCandidate = <C>(codec: Schema.Codec<C>, candidate: C): Effect.Effect<Readonly<Record<string, unknown>>, AssessmentError> =>
  Schema.encodeEffect(codec)(candidate).pipe(
    Effect.flatMap((encoded) => Schema.decodeUnknownEffect(CandidateRecord)(encoded)),
    Effect.mapError((error) => invalid(`Candidate must encode as a record: ${String(error)}`)),
  )

const runCandidate = <I, O, E, Ref, C extends { readonly id: string }, R, Shared>(
  definition: Calibration<I, O, E, Ref, C, R, Shared>,
  settings: CalibrationRunSettings,
  cases: ReadonlyArray<DatasetCase<I, Ref>>,
  candidate: C,
  encoded: Readonly<Record<string, unknown>>,
) => Effect.gen(function* () {
  const store = yield* EvaluationStore
  const services = isolatedServices(definition.subject.services(candidate))
  const cells = cases.flatMap((entry) => Array.from({ length: settings.repetitions }, (_, index) => ({ entry, sample: index + 1 })))
  return yield* Effect.forEach(cells, ({ entry, sample }) => Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const id = EvaluationId.make(`${settings.runId}/${definition.id}/${candidate.id}/${entry.id}/${sample}`)
    const execution = yield* restore(Effect.scoped(definition.subject.task(entry.input).pipe(
      Effect.tap(({ output, evidence }) => Effect.all([Schema.decodeEffect(Schema.toType(definition.output))(output), Schema.decodeEffect(Schema.toType(definition.evidence))(evidence)])),
      Effect.timeoutOrElse({ duration: settings.timeoutMs, orElse: () => Effect.fail(new AssessmentError({ code: "timeout", message: "Task execution exceeded its deadline" })) }),
      Effect.provide(services),
    ))).pipe(Effect.exit)
    const trial: EvaluationTrial = {
      version: 2, id, target: definition.id, kind: "benchmark", dataset: definition.dataset.id, datasetVersion: definition.dataset.version,
      caseId: entry.id, split: entry.split, review: entry.review, candidate: encoded, sample,
      startedAt, endedAt: yield* Clock.currentTimeMillis,
      status: Exit.isSuccess(execution) ? "completed" : Cause.hasInterruptsOnly(execution.cause) ? "cancelled" : "error",
      output: Exit.isSuccess(execution) ? Option.some(execution.value.output) : Option.none(),
      evidence: Exit.isSuccess(execution) ? Option.some(execution.value.evidence) : Option.none(),
      reason: Exit.isSuccess(execution) ? Option.none() : Option.some(Cause.pretty(execution.cause)), evaluations: [],
    }
    yield* store.writeTrial(trial)
    if (Exit.isFailure(execution)) return trial
    const input = { input: entry.input, output: execution.value.output, evidence: execution.value.evidence, reference: entry.reference }
    const recorded = yield* Ref.make<ReadonlyArray<EvaluationResult>>([])
    const assessmentExit = yield* restore(Effect.forEach(definition.evaluators, (binding) => assess(binding, input).pipe(
      Effect.provide(services),
      Effect.flatMap((result) => Effect.uninterruptible(store.writeAssessment(id, result).pipe(
        Effect.andThen(Ref.update(recorded, (prior) => [...prior, result])),
      ))),
    ))).pipe(Effect.exit)
    const evaluations = yield* Ref.get(recorded)
    if (Exit.isFailure(assessmentExit)) {
      yield* store.writeTrial({ ...trial, evaluations, status: Cause.hasInterruptsOnly(assessmentExit.cause) ? "cancelled" : "error", reason: Option.some(Cause.pretty(assessmentExit.cause)), endedAt: yield* Clock.currentTimeMillis })
      return yield* Effect.failCause(assessmentExit.cause)
    }
    const settled = { ...trial, evaluations, endedAt: yield* Clock.currentTimeMillis }
    yield* store.writeTrial(settled)
    return settled
  })).pipe(Effect.withSpan("eval.trial", { attributes: { "eval.calibration": definition.id, "eval.candidate": candidate.id, "eval.case": entry.id, "eval.sample": sample } })), { concurrency: settings.concurrency })
})

/**
 * Runs every candidate over the split's cases, each case on fresh services, and
 * reports metrics, gates, performance and the host's recommendation. A failed
 * candidate is reported, never hidden; completed trials are kept.
 */
export const runCalibration = <I, O, E, Ref, C extends { readonly id: string }, R, Shared>(
  definition: Calibration<I, O, E, Ref, C, R, Shared>,
  run: CalibrationRun,
): Effect.Effect<CalibrationReport, AssessmentError, Shared | EvaluationStore> => Effect.gen(function* () {
  yield* validateCalibration(definition)
  const settings = yield* settingsOf(definition, run)
  const cases = definition.dataset.cases.filter((entry) => entry.split === settings.split)
  if (cases.length === 0) return yield* Effect.fail(invalid(`The dataset has no ${settings.split} cases`))
  const reviewed = cases.every((entry) => entry.review !== "provisional")
  const encoded = yield* Effect.forEach(definition.candidates, (candidate) => encodeCandidate(definition.candidate, candidate))
  const batches = yield* Effect.forEach(definition.candidates, (candidate, index) =>
    runCandidate(definition, settings, cases, candidate, encoded[index]!).pipe(Effect.exit, Effect.map((result) => ({ candidate, result }))))
  const trials = batches.flatMap(({ result }) => Exit.isSuccess(result) ? result.value : [])
  const failures = batches.flatMap(({ candidate, result }) => Exit.isFailure(result) ? [{ candidate: candidate.id, reason: Cause.pretty(result.cause) }] : [])
  const candidates = definition.candidates.map((candidate, index) =>
    candidateReport(definition, candidate, encoded[index]!, trials.filter((trial) => trial.candidate.id === candidate.id), reviewed))
  const summaries: ReadonlyArray<CandidateSummary<C>> = candidates.map((report, index) => ({ ...report, candidate: definition.candidates[index]! }))
  const recommendation = Option.fromNullishOr(definition.select).pipe(Option.flatMap((select) => Option.fromNullishOr(select(summaries)[0])), Option.map((summary) => summary.id))
  const promotionEligible = Option.match(recommendation, {
    onNone: () => false,
    onSome: (id) => reviewed && failures.length === 0 && candidates.some((report) => report.id === id && report.passed),
  })
  return {
    version: 1 as const, calibration: { id: definition.id, version: definition.version }, identity: calibrationIdentity(definition), run: settings,
    reviewed, trials, candidates, failures, recommendation, promotionEligible,
  }
}).pipe(Effect.withSpan("eval.calibration", { attributes: { "eval.calibration": definition.id } }))
